import {
  fetchAccountsWithToken,
  fetchWorkspacesForAccountWithToken,
  provisionWorkspaceWithToken,
} from '@kortix/sdk';

const BACKEND_TIMEOUT_MS = 8_000;
const PROVISION_TIMEOUT_MS = 90_000;

/**
 * For brand-new signups, ensure the personal account has a starter workspace and
 * return the path to open it. Best-effort — callers fall back to /workspaces.
 */
export async function resolveFirstWorkspacePathForNewUser(opts: {
  backendUrl: string;
  accessToken: string;
  isNewUser: boolean;
}): Promise<string | null> {
  if (!opts.isNewUser || !opts.backendUrl || !opts.accessToken) return null;

  const tokenOpts = { backendUrl: opts.backendUrl, accessToken: opts.accessToken };

  const accounts = await fetchAccountsWithToken({ ...tokenOpts, timeoutMs: BACKEND_TIMEOUT_MS });
  const accountId = accounts?.[0]?.account_id;
  if (!accountId) return null;

  const listWorkspaces = () =>
    fetchWorkspacesForAccountWithToken({ ...tokenOpts, timeoutMs: BACKEND_TIMEOUT_MS }, accountId);

  const existing = await listWorkspaces();
  if (existing && existing.length > 0 && existing[0]?.workspace_id) {
    return `/workspaces/${existing[0].workspace_id}`;
  }

  const result = await provisionWorkspaceWithToken(
    { ...tokenOpts, timeoutMs: PROVISION_TIMEOUT_MS },
    {
      account_id: accountId,
      name: 'My First Workspace',
      seed_starter: true,
      starter_template: 'general-knowledge-worker',
    },
  );

  if (result.ok) {
    if (result.workspace.workspace_id) return `/workspaces/${result.workspace.workspace_id}`;
    // A 200 with no workspace_id is not a usable success — fall through to the
    // safe default (`/workspaces`) rather than building a broken path.
    return null;
  }

  if (result.limitReached) {
    const retry = await listWorkspaces();
    if (retry?.[0]?.workspace_id) return `/workspaces/${retry[0].workspace_id}`;
  }

  return null;
}
