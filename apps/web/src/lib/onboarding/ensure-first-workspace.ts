import { listWorkspacesForAccount, type KortixWorkspace } from '@kortix/sdk';

export type FirstWorkspaceAutoCreateState = {
  bootstrapRequested: boolean;
  activeAccountId: string | null;
  canCreateWorkspaces: boolean;
  autoCreateAttempted: boolean;
  accountsLoading: boolean;
  workspacesLoading: boolean;
  workspacesError: boolean;
  workspacesLoaded: boolean;
  workspaceCount: number;
  legacyMachinesLoaded: boolean;
  legacyMachineCount: number;
  billingEnabled: boolean;
  accountStateLoading: boolean;
  canRun: boolean;
};

export function hasFirstWorkspaceBootstrapSignal(searchParams: URLSearchParams): boolean {
  return (
    searchParams.get('team_signup') === 'success' || searchParams.get('auth_event') === 'signup'
  );
}

export function isWorkspaceLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('workspace_limit_reached') || message.includes('Free accounts are limited to')
  );
}

/**
 * True for the 503 `POST /workspaces/provision` returns when no managed-git
 * backend is configured (e.g. self-host with no MANAGED_GIT_* set) — an
 * EXPECTED, operator-fixable state, not a bug. Checks the status code first
 * (ApiError carries `.status`) and falls back to the message text for any
 * caller that only has a plain Error.
 */
export function isManagedGitUnavailableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 503) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('is not configured on this server');
}

/**
 * Return the account's first workspace. Empty accounts deliberately return null:
 * repository ownership is a user choice, so onboarding opens the create flow
 * and asks for a GitHub App installation (preferred) or explicit managed Git.
 */
export async function ensureFirstWorkspace(accountId: string): Promise<KortixWorkspace | null> {
  const existing = await listWorkspacesForAccount(accountId);
  return existing[0] ?? null;
}

export function shouldAutoCreateFirstWorkspace(state: FirstWorkspaceAutoCreateState): boolean {
  if (!state.bootstrapRequested) return false;
  if (!state.activeAccountId || !state.canCreateWorkspaces) return false;
  if (state.autoCreateAttempted) return false;
  if (state.accountsLoading || state.workspacesLoading || state.workspacesError) return false;
  if (!state.workspacesLoaded) return false;
  if (state.workspaceCount > 0) return false;
  if (state.legacyMachinesLoaded && state.legacyMachineCount > 0) return false;

  if (state.billingEnabled) {
    if (state.accountStateLoading) return false;
    if (!state.canRun) return false;
  }

  return true;
}
