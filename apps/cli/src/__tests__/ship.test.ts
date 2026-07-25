import { describe, expect, test } from 'bun:test';

import type { ApiClient } from '../api/client.ts';
import type { WorkspaceSummary } from '../api/types.ts';
import {
  authHeaderArgs,
  linkGitHubBackedWorkspace,
  reconcileShippedManifest,
  resolveExistingShipGitTarget,
  resolveProvisionShipGitTarget,
} from '../commands/ship.ts';

test('managed git auth headers honor the provider-selected username', () => {
  const args = authHeaderArgs('https://kortix.code.storage/demo.git', 'jwt-token', 't');
  expect(args.at(-1)).toStartWith(
    'http.https://kortix.code.storage/.extraheader=Authorization: Basic ',
  );
  const encoded = args.at(-1)?.split('Authorization: Basic ')[1];
  expect(encoded && Buffer.from(encoded, 'base64').toString('utf8')).toBe('t:jwt-token');
});

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    workspace_id: 'proj_1',
    account_id: 'acct_1',
    name: 'Demo',
    repo_url: 'https://github.com/managed-kortix/demo.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function recordingClient(
  calls: Array<{ path: string; body: unknown }>,
  linkedWorkspace: WorkspaceSummary,
): ApiClient {
  return {
    apiBase: 'https://api.kortix.test',
    post: async <T>(path: string, body?: unknown) => {
      calls.push({ path, body });
      return { workspace: linkedWorkspace } as T;
    },
  } as unknown as ApiClient;
}

describe('GitHub-backed workspace linking', () => {
  test('uses the workspaces-mounted route with a GitHub PAT', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];

    await linkGitHubBackedWorkspace(recordingClient(calls, workspace()), {
      repoUrl: 'https://github.com/acme/demo.git',
      name: 'Demo',
      accountId: 'acct_1',
      githubToken: 'github_pat_test',
      yes: true,
    });

    expect(calls).toEqual([
      {
        path: '/workspaces/link-repository',
        body: {
          repo_url: 'https://github.com/acme/demo.git',
          name: 'Demo',
          account_id: 'acct_1',
          github_token: 'github_pat_test',
        },
      },
    ]);
  });

  test('uses the workspaces-mounted route with the GitHub App', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];

    await linkGitHubBackedWorkspace(recordingClient(calls, workspace()), {
      repoUrl: 'https://github.com/acme/demo.git',
      name: 'Demo',
      accountId: 'acct_1',
      yes: true,
    });

    expect(calls).toEqual([
      {
        path: '/workspaces/link-repository',
        body: {
          repo_url: 'https://github.com/acme/demo.git',
          name: 'Demo',
          account_id: 'acct_1',
        },
      },
    ]);
  });
});

describe('ship git target resolution', () => {
  test('first-time managed ship pushes to the managed upstream with the provision token', () => {
    const target = resolveProvisionShipGitTarget({
      ...workspace({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
      push_token: 'ghp_push',
      repo_id: 'repo_1',
    });

    expect(target).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      credentialMode: 'managed-git-token',
    });
  });

  test('existing managed ship ignores proxy origin and mints a managed git token', () => {
    const target = resolveExistingShipGitTarget(
      workspace({
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: true } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://github.com/managed-kortix/demo.git',
      credentialMode: 'managed-git-token',
    });
  });

  test('non-managed proxy workspaces still push through the Kortix git proxy', () => {
    const target = resolveExistingShipGitTarget(
      workspace({
        repo_url: 'https://github.com/acme/byo.git',
        git_origin_url: 'https://api.kortix.com/v1/git/proj_1.git',
        metadata: { git: { managed: false } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://api.kortix.com/v1/git/proj_1.git',
      credentialMode: 'kortix-token',
    });
  });

  test('plain BYO workspaces rely on local git credentials', () => {
    const target = resolveExistingShipGitTarget(
      workspace({
        repo_url: 'https://github.com/acme/byo.git',
        metadata: { git: { managed: false } },
      }),
    );

    expect(target).toEqual({
      repoUrl: 'https://github.com/acme/byo.git',
      credentialMode: 'none',
    });
  });
});

test('ship reconciles the remote manifest independently of connector prompts', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = recordingClient(calls, workspace());

  await reconcileShippedManifest(client, 'proj_1');

  expect(calls).toEqual([
    {
      path: '/executor/workspaces/proj_1/connectors/sync',
      body: undefined,
    },
  ]);
});
