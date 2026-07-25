import { accountModelPreferences, workspaceLlmRoutingPolicies } from "@kortix/db";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../shared/db";
import type {
  WorkspaceModelGenerationConfig,
  WorkspaceRoutingFallback,
  WorkspaceRoutingPolicyInput,
  WorkspaceRoutingRule,
} from "../llm-gateway/routing/workspace-policy";

export interface StoredWorkspaceRoutingPolicy {
  visionModel: string | null;
  defaultFallback: WorkspaceRoutingFallback | null;
  rules: WorkspaceRoutingRule[];
  modelGenerationConfig: WorkspaceModelGenerationConfig;
}

function fromRow(
  row: typeof workspaceLlmRoutingPolicies.$inferSelect,
): StoredWorkspaceRoutingPolicy {
  return {
    visionModel: row.visionModel,
    defaultFallback:
      row.defaultFallbackModels === null
        ? null
        : {
            models: row.defaultFallbackModels,
            fallbackOn: row.defaultFallbackOn as "transient" | "any-error",
          },
    rules: row.rules,
    modelGenerationConfig: (row.modelGenerationConfig ?? {}) as WorkspaceModelGenerationConfig,
  };
}

export async function getWorkspaceRoutingPolicy(
  workspaceId: string,
): Promise<StoredWorkspaceRoutingPolicy | null> {
  // Do not process-cache this document. API replicas cannot invalidate each
  // other's memory, so an immediate read after a write can otherwise return a
  // stale policy from whichever pod served an earlier request.
  const [row] = await db
    .select()
    .from(workspaceLlmRoutingPolicies)
    .where(eq(workspaceLlmRoutingPolicies.workspaceId, workspaceId))
    .limit(1);
  return row ? fromRow(row) : null;
}

/** Persist the complete workspace document and its default model atomically. */
export async function setWorkspaceRoutingPolicy(params: {
  workspaceId: string;
  accountId: string;
  updatedBy: string;
  policy: WorkspaceRoutingPolicyInput;
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const preferenceWhere = and(
      eq(accountModelPreferences.accountId, params.accountId),
      eq(accountModelPreferences.scope, "workspace"),
      eq(accountModelPreferences.scopeKey, params.workspaceId),
    );
    if (params.policy.defaultModel) {
      await tx
        .insert(accountModelPreferences)
        .values({
          accountId: params.accountId,
          scope: "workspace",
          scopeKey: params.workspaceId,
          model: params.policy.defaultModel,
          updatedBy: params.updatedBy,
        })
        .onConflictDoUpdate({
          target: [
            accountModelPreferences.accountId,
            accountModelPreferences.scope,
            accountModelPreferences.scopeKey,
          ],
          // workspace-scope default is a workspace_id-IS-NULL row, so the ON CONFLICT
          // arbiter must name the GLOBAL partial unique index's predicate (PR #4978
          // split the old single unique index into two partial indexes). Without
          // this, Postgres errors "no unique/exclusion constraint matching ON
          // CONFLICT" and the routing-policy PUT 500s whenever defaultModel is set.
          targetWhere: sql`workspace_id is null`,
          set: {
            model: params.policy.defaultModel,
            updatedBy: params.updatedBy,
            updatedAt: now,
          },
        });
    } else {
      await tx.delete(accountModelPreferences).where(preferenceWhere);
    }

    await tx
      .insert(workspaceLlmRoutingPolicies)
      .values({
        workspaceId: params.workspaceId,
        visionModel: params.policy.visionModel,
        defaultFallbackModels: params.policy.defaultFallback?.models ?? null,
        defaultFallbackOn: params.policy.defaultFallback?.fallbackOn ?? null,
        rules: params.policy.rules,
        modelGenerationConfig: params.policy.modelGenerationConfig,
        updatedBy: params.updatedBy,
      })
      .onConflictDoUpdate({
        target: workspaceLlmRoutingPolicies.workspaceId,
        set: {
          visionModel: params.policy.visionModel,
          defaultFallbackModels: params.policy.defaultFallback?.models ?? null,
          defaultFallbackOn: params.policy.defaultFallback?.fallbackOn ?? null,
          rules: params.policy.rules,
          modelGenerationConfig: params.policy.modelGenerationConfig,
          updatedBy: params.updatedBy,
          updatedAt: now,
        },
      });
  });
}

export async function resetWorkspaceRoutingPolicy(params: {
  workspaceId: string;
  accountId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(workspaceLlmRoutingPolicies)
      .where(eq(workspaceLlmRoutingPolicies.workspaceId, params.workspaceId));
    await tx
      .delete(accountModelPreferences)
      .where(
        and(
          eq(accountModelPreferences.accountId, params.accountId),
          eq(accountModelPreferences.scope, "workspace"),
          eq(accountModelPreferences.scopeKey, params.workspaceId),
        ),
      );
  });
}
