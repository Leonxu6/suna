/**
 * Integration test (real local DB): triggers NEVER impersonate a picked human.
 *
 * The old "Runs as <member>" selector + per-trigger owner override are gone —
 * automated runs must not assume a human identity. This proves the deprecated
 * `workspace_trigger_runtime.owner_user_id` column is IGNORED: even with a stale
 * owner set to some other user, resolveTriggerActor resolves to the workspace's
 * system automation actor (the account owner), never the picked member.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { workspaceTriggerRuntime } from '@kortix/db';
import { db } from '../shared/db';
import { resolveTriggerActor } from '../workspaces/lib/triggers';
import { resolveWorkspaceAutomationActor } from '../workspaces/session-lifecycle';
import type { WorkspaceRow } from '../workspaces/lib/serializers';

let ctx: { workspaceId: string; accountId: string } | null = null;
const SLUG = `e2e-actor-${crypto.randomUUID().slice(0, 8)}`;
const STALE_PICKED_HUMAN = crypto.randomUUID();

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select workspace_id, account_id from kortix.workspaces limit 1`,
  )) as unknown as Array<{ workspace_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { workspaceId: rows[0].workspace_id, accountId: rows[0].account_id };

  // Seed a runtime row with a STALE owner pointing at some other user, as a
  // legacy trigger would have. The new resolver must not honor it.
  await db
    .insert(workspaceTriggerRuntime)
    .values({ workspaceId: ctx.workspaceId, slug: SLUG, ownerUserId: STALE_PICKED_HUMAN, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [workspaceTriggerRuntime.workspaceId, workspaceTriggerRuntime.slug],
      set: { ownerUserId: STALE_PICKED_HUMAN, updatedAt: new Date() },
    });
});

afterAll(async () => {
  if (!ctx) return;
  await db
    .delete(workspaceTriggerRuntime)
    .where(and(eq(workspaceTriggerRuntime.workspaceId, ctx.workspaceId), eq(workspaceTriggerRuntime.slug, SLUG)));
});

describe('resolveTriggerActor — no human impersonation', () => {
  test('ignores a stale owner_user_id; resolves to the workspace automation actor', async () => {
    if (!ctx) {
      console.warn('[integration] no workspace in local DB — skipping');
      return;
    }
    const actor = await resolveTriggerActor({ accountId: ctx.accountId } as WorkspaceRow);
    // Owner is IGNORED: the resolver returns exactly the automation actor — the
    // same value whether or not any owner row exists (both may be null).
    const automationActor = await resolveWorkspaceAutomationActor(ctx.accountId);
    expect(actor).toBe(automationActor);
    // And it is NEVER the seeded picked human (the whole point of the removal).
    expect(actor).not.toBe(STALE_PICKED_HUMAN);
  });
});
