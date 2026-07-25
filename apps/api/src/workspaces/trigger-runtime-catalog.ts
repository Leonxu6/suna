import { workspaceTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  type TriggerRuntimeCatalogStore,
  reconcileWorkspaceTriggerRuntimeWithStore,
} from './trigger-runtime-catalog-core';
import type { GitTriggerSpec } from './triggers';

const databaseStore: TriggerRuntimeCatalogStore = {
  async list(workspaceId) {
    return db
      .select({
        slug: workspaceTriggerRuntime.slug,
        sessionId: workspaceTriggerRuntime.sessionId,
      })
      .from(workspaceTriggerRuntime)
      .where(eq(workspaceTriggerRuntime.workspaceId, workspaceId));
  },

  async upsert(workspaceId, spec) {
    const now = new Date();
    await db
      .insert(workspaceTriggerRuntime)
      .values({
        workspaceId,
        slug: spec.slug,
        sessionId: spec.pinnedSessionId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceTriggerRuntime.workspaceId, workspaceTriggerRuntime.slug],
        set: {
          sessionId: spec.pinnedSessionId,
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
