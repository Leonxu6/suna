import { workspaceTriggerExecutions, workspaceTriggerRuntime, workspaces } from '@kortix/db';
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { nextTriggerScheduleSlot } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

export type TriggerExecutionRow = typeof workspaceTriggerExecutions.$inferSelect;

export interface ClaimedScheduleSlot {
  execution: TriggerExecutionRow;
  inserted: boolean;
}

async function mapConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()),
  );
  return results;
}

function triggerPayload(input: {
  spec: GitTriggerSpec;
  scheduledFor: Date;
  claimedAt: Date;
  lastScheduledFor: Date | null;
}) {
  return {
    cron: {
      schedule: input.spec.cron ?? input.spec.runAt,
      timezone: input.spec.timezone,
      scheduled_for: input.scheduledFor.toISOString(),
      claimed_at: input.claimedAt.toISOString(),
      last_scheduled_for: input.lastScheduledFor?.toISOString() ?? null,
    },
    trigger: { slug: input.spec.slug, type: input.spec.type, kind: 'git' },
  };
}

/**
 * Atomically materialize due schedule slots.
 *
 * The execution insert and `next_fire_at` advance share one transaction. A
 * crash cannot lose a slot between those two writes. The unique slot index
 * plus the compare-and-swap update make concurrent scheduler pods safe.
 */
export async function claimDueScheduleSlots(input: {
  now: Date;
  limit: number;
}): Promise<ClaimedScheduleSlot[]> {
  const candidates = await db
    .select({
      workspaceId: workspaceTriggerRuntime.workspaceId,
      slug: workspaceTriggerRuntime.slug,
      scheduleRevision: workspaceTriggerRuntime.scheduleRevision,
      nextFireAt: workspaceTriggerRuntime.nextFireAt,
      lastScheduledFor: workspaceTriggerRuntime.lastScheduledFor,
      scheduleSpec: workspaceTriggerRuntime.scheduleSpec,
    })
    .from(workspaceTriggerRuntime)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceTriggerRuntime.workspaceId))
    .where(
      and(
        eq(workspaces.status, 'active'),
        eq(workspaceTriggerRuntime.enabled, true),
        eq(workspaceTriggerRuntime.triggerType, 'cron'),
        lte(workspaceTriggerRuntime.nextFireAt, input.now),
        sql`coalesce(${workspaces.metadata} ->> 'triggers_paused', 'false') <> 'true'`,
      ),
    )
    .orderBy(asc(workspaceTriggerRuntime.nextFireAt), asc(workspaceTriggerRuntime.workspaceId))
    .limit(input.limit);

  const results = await mapConcurrently(candidates, 8, async (candidate) => {
    if (!candidate.nextFireAt || !candidate.scheduleRevision || !candidate.scheduleSpec) {
      return null;
    }
    const scheduleRevision = candidate.scheduleRevision;
    const scheduleSpec = candidate.scheduleSpec;
    const spec = scheduleSpec as unknown as GitTriggerSpec;
    const scheduledFor = candidate.nextFireAt;
    // Coalesce missed recurring slots into one execution. After downtime, one
    // catch-up run is queued and the catalog advances to the first future slot.
    // This prevents a restart from producing an unbounded execution storm.
    const nextFireAt = spec.runAt ? null : nextTriggerScheduleSlot(spec, input.now);
    return db.transaction(async (tx) => {
      // Advance first. If the manifest was reconciled or another scheduler
      // claimed this slot after candidate selection, the CAS fails and no
      // stale execution row is inserted.
      const advanced = await tx
        .update(workspaceTriggerRuntime)
        .set({
          nextFireAt,
          lastScheduledFor: scheduledFor,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(workspaceTriggerRuntime.workspaceId, candidate.workspaceId),
            eq(workspaceTriggerRuntime.slug, candidate.slug),
            eq(workspaceTriggerRuntime.scheduleRevision, scheduleRevision),
            eq(workspaceTriggerRuntime.nextFireAt, scheduledFor),
          ),
        )
        .returning({ workspaceId: workspaceTriggerRuntime.workspaceId });

      if (!advanced[0]) return null;

      const inserted = await tx
        .insert(workspaceTriggerExecutions)
        .values({
          workspaceId: candidate.workspaceId,
          slug: candidate.slug,
          scheduleRevision,
          scheduledFor,
          status: 'queued',
          spec: scheduleSpec,
          payload: triggerPayload({
            spec,
            scheduledFor,
            claimedAt: input.now,
            lastScheduledFor: candidate.lastScheduledFor,
          }),
          availableAt: input.now,
          claimedAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            workspaceTriggerExecutions.workspaceId,
            workspaceTriggerExecutions.slug,
            workspaceTriggerExecutions.scheduleRevision,
            workspaceTriggerExecutions.scheduledFor,
          ],
        })
        .returning();

      if (inserted[0]) return { execution: inserted[0], inserted: true };

      const [existing] = await tx
        .select()
        .from(workspaceTriggerExecutions)
        .where(
          and(
            eq(workspaceTriggerExecutions.workspaceId, candidate.workspaceId),
            eq(workspaceTriggerExecutions.slug, candidate.slug),
            eq(workspaceTriggerExecutions.scheduleRevision, scheduleRevision),
            eq(workspaceTriggerExecutions.scheduledFor, scheduledFor),
          ),
        )
        .limit(1);
      return existing ? { execution: existing, inserted: false } : null;
    });
  });
  return results.filter((result): result is ClaimedScheduleSlot => result !== null);
}

export async function claimTriggerExecutions(input: {
  now: Date;
  workerId: string;
  limit: number;
  leaseMs?: number;
}): Promise<TriggerExecutionRow[]> {
  const leaseMs = input.leaseMs ?? 2 * 60_000;
  // A worker may die during its final attempt. Once that lease expires, make
  // the abandonment explicit instead of leaving a permanent `running` row.
  await db
    .update(workspaceTriggerExecutions)
    .set({
      status: 'dead_lettered',
      lockedBy: null,
      lockedUntil: null,
      lastError: 'execution lease expired after the maximum number of attempts',
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        gte(workspaceTriggerExecutions.attempts, 5),
        or(
          and(
            eq(workspaceTriggerExecutions.status, 'queued'),
            lte(workspaceTriggerExecutions.availableAt, input.now),
          ),
          and(
            eq(workspaceTriggerExecutions.status, 'running'),
            or(
              isNull(workspaceTriggerExecutions.lockedUntil),
              lte(workspaceTriggerExecutions.lockedUntil, input.now),
            ),
          ),
        ),
      ),
    );

  const candidates = await db
    .select()
    .from(workspaceTriggerExecutions)
    .where(
      and(
        lt(workspaceTriggerExecutions.attempts, 5),
        or(
          and(
            eq(workspaceTriggerExecutions.status, 'queued'),
            lte(workspaceTriggerExecutions.availableAt, input.now),
          ),
          and(
            eq(workspaceTriggerExecutions.status, 'running'),
            or(
              isNull(workspaceTriggerExecutions.lockedUntil),
              lte(workspaceTriggerExecutions.lockedUntil, input.now),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(workspaceTriggerExecutions.availableAt), asc(workspaceTriggerExecutions.createdAt))
    .limit(input.limit);

  const claimed = await mapConcurrently(candidates, 8, async (candidate) => {
    const [row] = await db
      .update(workspaceTriggerExecutions)
      .set({
        status: 'running',
        attempts: candidate.attempts + 1,
        lockedBy: input.workerId,
        lockedUntil: new Date(input.now.getTime() + leaseMs),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workspaceTriggerExecutions.executionId, candidate.executionId),
          eq(workspaceTriggerExecutions.attempts, candidate.attempts),
          or(
            eq(workspaceTriggerExecutions.status, 'queued'),
            and(
              eq(workspaceTriggerExecutions.status, 'running'),
              or(
                isNull(workspaceTriggerExecutions.lockedUntil),
                lte(workspaceTriggerExecutions.lockedUntil, input.now),
              ),
            ),
          ),
        ),
      )
      .returning();
    return row ?? null;
  });
  return claimed.filter((row): row is TriggerExecutionRow => row !== null);
}

function ownedRunningExecution(row: TriggerExecutionRow) {
  return and(
    eq(workspaceTriggerExecutions.executionId, row.executionId),
    eq(workspaceTriggerExecutions.status, 'running'),
    eq(workspaceTriggerExecutions.attempts, row.attempts),
  );
}

export async function markTriggerExecutionDispatched(input: {
  row: TriggerExecutionRow;
  dispatchedAt: Date;
}): Promise<void> {
  await db
    .update(workspaceTriggerExecutions)
    .set({
      dispatchedAt: input.dispatchedAt,
      updatedAt: input.dispatchedAt,
    })
    .where(ownedRunningExecution(input.row));
}

export async function markTriggerExecutionSucceeded(input: {
  row: TriggerExecutionRow;
  completedAt: Date;
  sessionId?: string | null;
  commandId?: string | null;
}): Promise<void> {
  await db
    .update(workspaceTriggerExecutions)
    .set({
      status: 'succeeded',
      sessionId: input.sessionId ?? null,
      commandId: input.commandId ?? null,
      completedAt: input.completedAt,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      updatedAt: input.completedAt,
    })
    .where(ownedRunningExecution(input.row));
}

export async function markTriggerExecutionSkipped(input: {
  row: TriggerExecutionRow;
  skippedAt: Date;
  reason: string;
}): Promise<void> {
  await db
    .update(workspaceTriggerExecutions)
    .set({
      status: 'skipped',
      lockedBy: null,
      lockedUntil: null,
      lastError: input.reason.slice(0, 2_000),
      completedAt: input.skippedAt,
      updatedAt: input.skippedAt,
    })
    .where(ownedRunningExecution(input.row));
}

export async function markTriggerExecutionFailed(input: {
  row: TriggerExecutionRow;
  failedAt: Date;
  error: string;
}): Promise<'queued' | 'dead_lettered'> {
  const terminal = input.row.attempts >= 5;
  const retryDelayMs = Math.min(60_000, 2 ** Math.max(0, input.row.attempts - 1) * 2_000);
  await db
    .update(workspaceTriggerExecutions)
    .set({
      status: terminal ? 'dead_lettered' : 'queued',
      availableAt: terminal ? input.failedAt : new Date(input.failedAt.getTime() + retryDelayMs),
      lockedBy: null,
      lockedUntil: null,
      lastError: input.error.slice(0, 2_000),
      completedAt: terminal ? input.failedAt : null,
      updatedAt: input.failedAt,
    })
    .where(ownedRunningExecution(input.row));
  return terminal ? 'dead_lettered' : 'queued';
}

export async function countUncatalogedTriggerWorkspaces(): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(distinct ${workspaceTriggerRuntime.workspaceId})` })
    .from(workspaceTriggerRuntime)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceTriggerRuntime.workspaceId))
    .where(and(eq(workspaces.status, 'active'), isNull(workspaceTriggerRuntime.scheduleRevision)));
  return Number(rows[0]?.count ?? 0);
}
