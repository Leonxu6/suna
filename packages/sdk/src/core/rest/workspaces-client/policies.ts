// Executor policies — kortix.yaml-backed workspace-wide tool policies.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';
import type { ConnectorSyncResult } from './connectors';

// ─── Executor policies (kortix.yaml-backed) ────────────────────────────────

export type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type PolicyDefaultMode = 'risk' | 'allow_all';

export interface WorkspacePolicy {
  match: string;
  action: PolicyAction;
}

export interface WorkspacePoliciesResponse {
  policies: WorkspacePolicy[];
  defaultMode: PolicyDefaultMode;
  errors: Array<{ path: string; error: string }>;
}

export async function listWorkspacePolicies(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspacePoliciesResponse>(`/executor/workspaces/${workspaceId}/policies`),
  );
}

export async function setWorkspacePolicies(
  workspaceId: string,
  policies: WorkspacePolicy[],
  defaultMode: PolicyDefaultMode,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/workspaces/${workspaceId}/policies`,
      { policies, defaultMode },
    ),
  );
}
