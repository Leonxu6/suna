import { workspaceTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  type TriggerRuntimeCatalogStore,
  reconcileWorkspaceTriggerRuntimeWithStore,
} from './trigger-runtime-catalog-core';
import { initialTriggerScheduleSlot } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

const databaseStore: TriggerRuntimeCatalogStore = {
  async list(workspaceId) {
    return db
      .select({
        slug: workspaceTriggerRuntime.slug,
        sessionId: workspaceTriggerRuntime.sessionId,
        scheduleRevision: workspaceTriggerRuntime.scheduleRevision,
      })
      .from(workspaceTriggerRuntime)
      .where(eq(workspaceTriggerRuntime.workspaceId, workspaceId));
  },

  async upsert(workspaceId, spec, scheduleRevision) {
    const now = new Date();
    const nextFireAt = initialTriggerScheduleSlot(spec, now);
    await db
      .insert(workspaceTriggerRuntime)
      .values({
        workspaceId,
        slug: spec.slug,
        sessionId: spec.pinnedSessionId,
        triggerType: spec.type,
        enabled: spec.enabled,
        scheduleCron: spec.cron,
        scheduleRunAt: spec.runAt ? new Date(spec.runAt) : null,
        scheduleTimezone: spec.timezone,
        scheduleRevision,
        scheduleSpec: spec as unknown as Record<string, unknown>,
        nextFireAt,
        lastScheduledFor: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceTriggerRuntime.workspaceId, workspaceTriggerRuntime.slug],
        set: {
          sessionId: spec.pinnedSessionId,
          triggerType: spec.type,
          enabled: spec.enabled,
          scheduleCron: spec.cron,
          scheduleRunAt: spec.runAt ? new Date(spec.runAt) : null,
          scheduleTimezone: spec.timezone,
          scheduleRevision,
          scheduleSpec: spec as unknown as Record<string, unknown>,
          nextFireAt,
          lastScheduledFor: null,
          updatedAt: now,
        },
      });
  },

  async remove(workspaceId, slug) {
    await db
      .delete(workspaceTriggerRuntime)
      .where(
        and(eq(workspaceTriggerRuntime.workspaceId, workspaceId), eq(workspaceTriggerRuntime.slug, slug)),
      );
  },
};

export async function reconcileWorkspaceTriggerRuntime(
  workspaceId: string,
  specs: readonly GitTriggerSpec[],
  store: TriggerRuntimeCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileWorkspaceTriggerRuntimeWithStore(workspaceId, specs, store);
}

export type { TriggerRuntimeCatalogStore } from './trigger-runtime-catalog-core';
