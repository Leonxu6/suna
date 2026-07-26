/**
 * E2E for the per-account WORKSPACE LIMIT — the guard that stops a free account
 * from creating an unbounded number of workspaces. Free accounts get 1 workspace;
 * any paid plan gets the effectively-uncapped `MAX_WORKSPACES_PER_ACCOUNT`.
 *
 * This drives the real `POST /v1/workspaces/provision` handler (and its real
 * `enforceWorkspaceQuota` chokepoint) against a stubbed managed-git backend and a
 * db mock with a configurable workspace count. The limit *number* itself comes
 * from `maxWorkspacesForAccount` (mocked here to a controllable value — its
 * plan→number policy is covered by `unit-workspace-limit-policy.test.ts`); what
 * this file proves is the enforcement wiring: at-limit → 403 before any repo is
 * created; under-limit → 201.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, workspaceMembers, workspaces } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const WORKSPACE_ID = '00000000-0000-4000-a000-000000000201';
const REPO_OWNER = 'kortix-managed';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

// ─── Per-test knobs ───────────────────────────────────────────────────────────
let workspaceLimit = 1; // what maxWorkspacesForAccount returns for the account
let workspaceCount = 0; // how many workspaces the account already owns (count(*))

function setTestAuth(userId = USER_ID, userEmail = 'limit@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}
function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'limit@example.test' };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (typeof url === 'string' && /\/env\//.test(url)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ─── Stub managed git backend ────────────────────────────────────────────────
const backendCalls: string[] = [];
const stubBackend = {
  id: 'github',
  isConfigured: async () => true,
  createRepo: async (input: any) => {
    backendCalls.push('createRepo');
    return {
      provider: 'github',
      upstreamUrl: `https://github.com/${REPO_OWNER}/${input.slug}.git`,
      externalRepoId: 'gh-repo-1',
      repoOwner: REPO_OWNER,
      repoName: input.slug,
      installationId: 'install-1',
      credentialRef: null,
      defaultBranch: input.defaultBranch,
      initialToken: 'scoped-push-token-789',
    };
  },
  deleteRepo: async () => { backendCalls.push('deleteRepo'); },
  buildUpstream: (ref: any) => ({ url: ref.upstreamUrl, headers: {} }),
  seedFiles: async () => { backendCalls.push('seedFiles'); },
};

mock.module('../workspaces/git-backends/index', () => ({
  hasBackend: (provider: string) => provider === 'github',
  getBackend: () => stubBackend,
  getDefaultManagedBackend: () => stubBackend,
  githubBackend: stubBackend,
  managedGithubInstallId: () => 'install-1',
  managedGithubOwner: () => null,
  managedGithubOwnerType: () => undefined,
  managedGithubToken: () => null,
  parseBasicAuthHeader: () => null,
}));

// The limit *number* is controlled here; the plan→number policy lives in the
// real maxWorkspacesForAccount (see unit-workspace-limit-policy.test.ts).
mock.module('../shared/account-limits', () => ({
  FREE_TIER_WORKSPACE_LIMIT: 3,
  maxWorkspacesForAccount: async () => workspaceLimit,
  maxConcurrentSessionsForTier: () => Number.MAX_SAFE_INTEGER,
  resolveAccountSessionLimit: async () => ({
    tier: 'free',
    limit: Number.MAX_SAFE_INTEGER,
    source: 'tier',
  }),
  resolveAccountTier: async () => 'free',
  accountEntitledToLlmGateway: async () => true,
  sessionLlmPolicyForTier: () => ({ limit: 60, windowMs: 60_000 }),
  clearAccountLimitCache: () => {},
}));

const realAuthMiddleware = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuthMiddleware,
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    await next();
  },
}));

mockIamEngineAllowAll();
mockIamMembershipSyncNoop();

mock.module('../workspaces/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  createRemoteSessionBranch: async () => undefined,
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async () => [],
  loadWorkspaceConfig: async () => ({ env: { required: [], optional: [] } }),
  readRepoFile: async () => '',
  readManifestFromRepo: async () => null,
  invalidateWorkspaceMirror: () => {},
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveTreeOid: async () => 'b'.repeat(40),
  materializeRepoContext: async () => '/tmp/fake-snapshot-context',
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
  commitFileToBranch: async () => ({ commitSha: 'a'.repeat(40) }),
  deleteRemoteSessionBranch: async () => undefined,
  diffStat: async () => ({ files: [], additions: 0, deletions: 0 }),
  getFileAtRef: async () => null,
  getMergeBase: async () => 'a'.repeat(40),
  resolveBranchAheadState: async () => ({ ahead: false, commitsAhead: 0 }),
}));

mock.module('../snapshots/builder', () => ({
  ensureSandboxImage: async () => ({ snapshotName: 'kortix-default-test', slug: 'default', contentHash: 'a'.repeat(64), built: false, isDefault: true }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: 'kortix-default-test', slug: 'default' }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: 'default', spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickWorkspaceTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileWorkspaceTemplates: async () => ({ checked: 0, updated: 0 }),
  reconcileStaleBuilds: async () => ({ checked: 0, updated: 0 }),
  ensurePlatformDefaultImage: async () => ({ snapshotName: 'kortix-default-test', slug: 'default', contentHash: 'a'.repeat(64), built: false, isDefault: true }),
  resolveCommitSha: async () => 'a'.repeat(40),
  ensurePerWorkspaceWarmImage: async () => ({
    snapshotName: 'kortix-ppwarm-test',
    tip: 'a'.repeat(40),
    built: false,
    provider: 'daytona',
  }),
  DEFAULT_SANDBOX_SLUG: 'default',
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'limit@example.test' } } }) } },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  upsertCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => ({ tier: 'free' }),
  getCreditAccount: async () => null,
  getCreditBalance: async () => ({ balance: 0, granted: 0, used: 0 }),
  updateCreditAccount: async () => {},
}));

function workspaceRowFrom(values: any) {
  return {
    workspaceId: WORKSPACE_ID,
    accountId: values.accountId,
    name: values.name,
    repoUrl: values.repoUrl,
    defaultBranch: values.defaultBranch,
    manifestPath: values.manifestPath,
    status: values.status,
    metadata: values.metadata,
    lastOpenedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: values.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    // `workspaceion` lets us distinguish the count(*) quota query from the
    // membership / row lookups, which use `.where().limit()`.
    select: (workspaceion?: any) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === workspaces && workspaceion && typeof workspaceion === 'object' && 'count' in workspaceion) {
            // The enforceWorkspaceQuota count(*) query is awaited directly.
            return Promise.resolve([{ count: workspaceCount }]);
          }
          return {
            limit: async () => {
              if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
              return [];
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: () => {
          if (table === workspaceMembers) return Promise.resolve([]);
          return { returning: async () => (table === workspaces ? [workspaceRowFrom(values)] : []) };
        },
        returning: async () => (table === workspaces ? [workspaceRowFrom(values)] : []),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    delete: () => ({ where: async () => {} }),
  },
}));

const { workspacesApp } = await import('../workspaces/index');

function createApp() {
  const app = new Hono();
  app.route('/v1/workspaces', workspacesApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

function provision(name = 'Limited Agent') {
  return createApp().request('/v1/workspaces/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: ACCOUNT_ID, name, provider: 'github' }),
  });
}

describe('workspace limit — POST /v1/workspaces/provision', () => {
  beforeEach(() => {
    setTestAuth();
    backendCalls.length = 0;
    workspaceLimit = 3;
    workspaceCount = 0;
  });

  test('free account under its limit (count 2 < limit 3) → 201', async () => {
    workspaceLimit = 3;
    workspaceCount = 2;
    const res = await provision();
    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo']);
  });

  test('free account at its limit (count 3 ≥ limit 3) → 403, no repo created', async () => {
    workspaceLimit = 3;
    workspaceCount = 3;
    const res = await provision();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_limit_reached');
    expect(body.limit).toBe(3);
    expect(body.count).toBe(3);
    expect(body.error).toContain('Free accounts are limited to 3 workspaces');
    // Blocked BEFORE the managed repo is provisioned — no orphaned upstream repo.
    expect(backendCalls).toHaveLength(0);
  });

  test('paid plan creates well beyond the free limit (count 5 < limit 200) → 201', async () => {
    workspaceLimit = 200;
    workspaceCount = 5;
    const res = await provision();
    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo']);
  });

  test('paid plan at its (large) cap (count 200 ≥ limit 200) → 403', async () => {
    workspaceLimit = 200;
    workspaceCount = 200;
    const res = await provision();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_limit_reached');
    expect(body.error).toContain('limit of 200 workspaces');
    expect(backendCalls).toHaveLength(0);
  });

  test('billing disabled lifts the cap entirely (limit = MAX_SAFE_INTEGER) → 201', async () => {
    workspaceLimit = Number.MAX_SAFE_INTEGER;
    workspaceCount = 9999;
    const res = await provision();
    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo']);
  });
});
