import { beforeEach, describe, expect, mock, test } from 'bun:test';

const provisionCalls: unknown[] = [];
let workspaces: Array<{ workspace_id: string; account_id: string; name: string }> = [];

mock.module('@kortix/sdk', () => ({
  listWorkspacesForAccount: async () => workspaces,
  provisionWorkspace: async (input: unknown) => {
    provisionCalls.push(input);
    return { workspace_id: 'proj_1', account_id: 'acct_1', name: 'My First Workspace' };
  },
}));

mock.module('@/lib/marketplace-client', () => ({
  listDefaultWorkspaceMarketplaceItems: async () => [
    { id: 'kortix-starter:agent-browser' },
  ],
}));

describe('ensureFirstWorkspace provisioning', () => {
  beforeEach(() => {
    provisionCalls.length = 0;
    workspaces = [];
  });

  test('does not silently create a managed repository for a new account', async () => {
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(ensureFirstWorkspace('acct_1')).resolves.toBeNull();
    expect(provisionCalls).toEqual([]);
  });

  test('returns an existing workspace without provisioning', async () => {
    workspaces = [{ workspace_id: 'proj_existing', account_id: 'acct_1', name: 'Existing' }];
    const { ensureFirstWorkspace } = await import('./ensure-first-workspace');

    await expect(ensureFirstWorkspace('acct_1')).resolves.toMatchObject({
      workspace_id: 'proj_existing',
    });
    expect(provisionCalls).toEqual([]);
  });
});

describe('isManagedGitUnavailableError', () => {
  test('true for a 503-status error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-workspace');
    const err = new Error('nope');
    (err as Error & { status: number }).status = 503;
    expect(isManagedGitUnavailableError(err)).toBe(true);
  });

  test('true for the not-configured message with no status', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-workspace');
    expect(
      isManagedGitUnavailableError(new Error('Managed git provider "github" is not configured on this server')),
    ).toBe(true);
  });

  test('false for an unrelated error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-workspace');
    expect(isManagedGitUnavailableError(new Error('network error'))).toBe(false);
  });
});
