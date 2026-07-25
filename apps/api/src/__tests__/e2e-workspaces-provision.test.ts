/**
 * E2E for `POST /v1/workspaces/provision` — the managed-git path behind
 * `kortix ship` when a repo has no `origin` remote. The managed backend is
 * provider-agnostic (GitHub is the default + only active one), so this test
 * drives the endpoint against a stub `GitHostBackend` and asserts the
 * provider-neutral behaviour: create repo → mint push token → register workspace.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, workspaceGitConnections, workspaceMembers, workspaces } from '@kortix/db';

process.env.KORTIX_DEFAULT_MARKETPLACES = '';
process.env.MANAGED_GIT_PROVIDER = 'github';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const WORKSPACE_ID = '00000000-0000-4000-a000-000000000201';
const REPO_OWNER = 'kortix-managed';
const EXTERNAL_REPO_ID = 'gh-repo-1';
const INSTALL_ID = 'install-1';
const PUSH_TOKEN = 'scoped-push-token-789';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

let insertedWorkspace: any | null;
let grantedWorkspaceRole: any | null;
let updatedWorkspaceSets: any[];
let seedFilePaths: string[];
let seedBaseFilePaths: string[];
let seedFilesByPath: Map<string, string>;
let canonicalMembership: boolean;
let managedPat: string | null;
let provisionedInitialToken: string | null;

function setTestAuth(userId = USER_ID, userEmail = 'ship@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}
function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'ship@example.test' };
}

// ─── Stub fetch: sandbox secret lookups 404 so keys resolve from env. ─────────

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (typeof url === 'string' && /\/env\//.test(url)) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Stub managed git backend. The provision endpoint resolves the backend through
// `../workspaces/git-backends`; we register a single `github` backend whose
// `isConfigured()` we toggle to exercise the configured / not-configured paths.
let backendConfigured = true;
let createdSlug = '';
const backendCalls: string[] = [];

const stubBackend = {
  id: 'github',
  isConfigured: async () => backendConfigured,
  createRepo: async (input: any) => {
    backendCalls.push('createRepo');
    createdSlug = input.slug;
    return {
      provider: 'github',
      upstreamUrl: `https://github.com/${REPO_OWNER}/${input.slug}.git`,
      externalRepoId: EXTERNAL_REPO_ID,
      repoOwner: REPO_OWNER,
      repoName: input.slug,
      installationId: INSTALL_ID,
      credentialRef: null,
      defaultBranch: input.defaultBranch,
      initialToken: provisionedInitialToken,
    };
  },
  deleteRepo: async () => { backendCalls.push('deleteRepo'); },
  buildUpstream: (ref: any, token: string | null) => ({
    url: ref.upstreamUrl,
    headers: token
      ? { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
      : {},
  }),
  seedFiles: async (_ref: any, _token: string, files: Array<{ path: string; content: string }>, opts: { baseFiles?: Array<{ path: string; content: string }> }) => {
    backendCalls.push('seedFiles');
    seedFilePaths = files.map((file) => file.path).sort();
    seedBaseFilePaths = (opts.baseFiles ?? []).map((file) => file.path).sort();
    seedFilesByPath = new Map(files.map((file) => [file.path, file.content] as const));
  },
};

mock.module('../workspaces/git-backends/index', () => ({
  hasBackend: (provider: string) => provider === 'github',
  getBackend: (provider: string) => (provider === 'github' ? stubBackend : stubBackend),
  getDefaultManagedBackend: () => stubBackend,
  githubBackend: stubBackend,
  managedGithubInstallId: () => INSTALL_ID,
  managedGithubOwner: () => REPO_OWNER,
  managedGithubOwnerType: () => undefined,
  managedGithubToken: () => managedPat,
  parseBasicAuthHeader: (value?: string | null) => {
    if (!value?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator > 0
      ? { username: decoded.slice(0, separator), token: decoded.slice(separator + 1) }
      : null;
  },
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

// Bypass the IAM engine — it queries account-group tables with .innerJoin that
// this file's lightweight db mock doesn't model. Mock only the engine so the
// real ../iam barrel still re-exports actions, assertAuthorized, etc. We're
// verifying provision/delete behavior, not the access-control engine itself.
mockIamEngineAllowAll();

// grantWorkspaceRole syncs IAM policy rows; no-op those (they hit tables the
// lightweight db mock doesn't model).
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

mock.module("../snapshots/builder", () => ({
  ensureSandboxImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: "kortix-default-test", slug: "default" }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: "default", spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickWorkspaceTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileWorkspaceTemplates: async () => ({ checked: 0, updated: 0 }),
  reconcileStaleBuilds: async () => ({ checked: 0, updated: 0 }),
  ensurePlatformDefaultImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  resolveCommitSha: async () => "a".repeat(40),
  ensurePerWorkspaceWarmImage: async () => ({
    snapshotName: "kortix-ppwarm-test",
    tip: "a".repeat(40),
    built: false,
    provider: "daytona",
  }),
  DEFAULT_SANDBOX_SLUG: "default",
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async () => undefined,
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'ship@example.test' } } }) } },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
  getCreditAccount: async () => null,
  getCreditBalance: async () => ({ balance: 0, granted: 0, used: 0 }),
  upsertCreditAccount: async () => {},
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

function existingWorkspaceRow() {
  return workspaceRowFrom({
    accountId: ACCOUNT_ID,
    name: 'Existing Managed Workspace',
    repoUrl: `https://github.com/${REPO_OWNER}/existing-managed.git`,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {
      git: {
        url: `https://github.com/${REPO_OWNER}/existing-managed.git`,
        provider: 'github',
        managed: true,
        auth: { method: 'github_app', installation_id: INSTALL_ID },
        owner: REPO_OWNER,
      },
    },
  });
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (workspaceion?: any) => ({
      from: (table: unknown) => ({
        where: () => {
          // The workspace-limit guard's count(*) query is awaited directly
          // (no .limit()). 0 keeps provision under any plan's cap.
          if (table === workspaces && workspaceion && typeof workspaceion === 'object' && 'count' in workspaceion) {
            return Promise.resolve([{ count: 0 }]);
          }
          return {
            limit: async () => {
              if (table === accountMembers) {
                if (canonicalMembership) {
                  return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
                }
                return [];
              }
              if (table === workspaceMembers) {
                return [{ workspaceRole: 'manager' }];
              }
              if (table === workspaces) {
                return [existingWorkspaceRow()];
              }
              if (table === workspaceGitConnections) {
                return [{
                  accountId: ACCOUNT_ID,
                  workspaceId: WORKSPACE_ID,
                  provider: 'github',
                  repoUrl: `https://github.com/${REPO_OWNER}/existing-managed.git`,
                  upstreamUrl: `https://github.com/${REPO_OWNER}/existing-managed.git`,
                  managed: true,
                  repoOwner: REPO_OWNER,
                  repoName: 'existing-managed',
                  externalRepoId: EXTERNAL_REPO_ID,
                  defaultBranch: 'main',
                  authMethod: 'github_app',
                  installationId: INSTALL_ID,
                  credentialRef: null,
                  permissions: {},
                  visibility: 'private',
                  webhookId: null,
                  status: 'connected',
                  metadata: {},
                  createdAt: new Date('2026-01-01T00:00:00Z'),
                  updatedAt: new Date('2026-01-01T00:00:00Z'),
                }];
              }
              return [];
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoNothing: () => {
          return Promise.resolve([]);
        },
        onConflictDoUpdate: () => {
          if (table === workspaces) {
            throw new Error('managed workspace provisioning must insert a fresh workspace row');
          }
          if (table === workspaceMembers) {
            grantedWorkspaceRole = values;
            return Promise.resolve([]);
          }
          return {
            returning: async () => {
              if (table !== workspaces) return [];
              insertedWorkspace = values;
              return [workspaceRowFrom(values)];
            },
          };
        },
        returning: async () => {
          if (table !== workspaces) return [];
          insertedWorkspace = values;
          return [workspaceRowFrom(values)];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: any) => ({
        where: () => {
          if (table === workspaces) updatedWorkspaceSets.push(values);
          // Real drizzle's UPDATE builder is thenable at every chain step
          // (a caller may `.catch()` it directly without `.returning()` —
          // see r1.ts's best-effort default_agent metadata mirror write, and
          // the several other `.where(...).catch(() => {})` call sites this
          // mirrors), so this stub must be too: a real Promise (which
          // supplies `.then`/`.catch`) that ALSO exposes `.returning()` for
          // callers that chain it.
          const result: any = Promise.resolve([]);
          result.returning = async () => [];
          return result;
        },
      }),
    }),
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

describe('POST /v1/workspaces/provision (managed git)', () => {
  beforeEach(() => {
    setTestAuth();
    insertedWorkspace = null;
    updatedWorkspaceSets = [];
    grantedWorkspaceRole = null;
    seedFilePaths = [];
    seedBaseFilePaths = [];
    seedFilesByPath = new Map();
    canonicalMembership = true;
    backendCalls.length = 0;
    backendConfigured = true;
    managedPat = null;
    provisionedInitialToken = PUSH_TOKEN;
  });

  test('provisions a managed repo + scoped token and registers the workspace', async () => {
    const app = createApp();
    const res = await app.request('/v1/workspaces/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // Repo slug = readable name + the (server-generated) workspace id; the managed
    // repo lives under the managed org. Response carries the workspace + scoped
    // push token for the CLI.
    expect(createdSlug).toMatch(/^my-agent-[0-9a-f-]{36}$/);
    const expectedRepoUrl = `https://github.com/${REPO_OWNER}/${createdSlug}.git`;
    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(body.repo_url).toBe(expectedRepoUrl);
    expect(body.repo_id).toBe(EXTERNAL_REPO_ID);
    expect(body.push_token).toBe(PUSH_TOKEN);
    expect(body.git_username).toBe('x-access-token');

    // Persisted row records the canonical typed git-remote reference.
    expect(insertedWorkspace).toMatchObject({
      accountId: ACCOUNT_ID,
      name: 'My Agent',
      repoUrl: expectedRepoUrl,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      status: 'active',
      metadata: {
        git: {
          url: expectedRepoUrl,
          provider: 'github',
          managed: true,
          auth: { method: 'github_app', installation_id: INSTALL_ID },
          owner: REPO_OWNER,
        },
      },
    });
    expect(grantedWorkspaceRole).toMatchObject({
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workspaceRole: 'manager',
    });

    // Provisioned the repo through the backend seam (no seeding without flag).
    expect(backendCalls).toEqual(['createRepo']);
  });

  test('does not return the server-global managed GitHub PAT as a provision push token', async () => {
    provisionedInitialToken = null;
    managedPat = 'server-global-ghp-token';

    const app = createApp();
    const res = await app.request('/v1/workspaces/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'PAT Fallback Workspace' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.push_token).toBeNull();
  });

  test('git-token fails closed when managed GitHub auth resolves to server-global PAT fallback', async () => {
    managedPat = 'server-global-ghp-token';

    const app = createApp();
    const res = await app.request(`/v1/workspaces/${WORKSPACE_ID}/git-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('repo-scoped installation token');
  });

  test('rejects an explicit account the caller has no membership in', async () => {
    canonicalMembership = false;

    const app = createApp();
    const res = await app.request('/v1/workspaces/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'No Membership Workspace' }),
    });

    expect(res.status).toBe(403);
    expect(insertedWorkspace).toBeNull();
  });

  test('seeds the deterministic starter into the initial managed repo setup commit (marketplace_items is a no-op)', async () => {
    // The deterministic install/lock engine is gone (see
    // docs/specs/2026-07-13-marketplace-as-workspaces.md) — provision seeds only
    // the plain starter scaffold. `marketplace_items` is accepted for API
    // back-compat but no longer installs anything at provision time; adding a
    // marketplace item to a workspace is now an agent import
    // (POST /:workspaceId/marketplace/install-session), which needs the workspace
    // (and a session) to already exist.
    const app = createApp();
    const res = await app.request('/v1/workspaces/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'Runtime Workspace',
        seed_starter: true,
        starter_template: 'minimal',
        marketplace_items: [
          'kortix-starter:agent-browser',
          'kortix-starter:deep-research',
          'kortix-starter:pdf',
        ],
      }),
    });

    expect(res.status).toBe(201);
    expect(backendCalls).toEqual(['createRepo', 'seedFiles']);

    // No lock is ever produced — the engine that wrote it is deleted.
    expect(seedFilePaths).not.toContain('registry-lock.json');
    // The requested marketplace skills are NOT deterministically installed —
    // only the always-present kortix-system skill (part of the base minimal
    // scaffold) is present.
    expect(seedFilePaths).not.toContain('.kortix/opencode/skills/agent-browser/SKILL.md');
    expect(seedFilePaths).not.toContain('.kortix/opencode/skills/deep-research/SKILL.md');
    expect(seedFilePaths).not.toContain('.kortix/opencode/skills/pdf/SKILL.md');
    expect(seedFilePaths).toContain('.kortix/opencode/skills/kortix-system/SKILL.md');
    expect(seedFilePaths).toContain('kortix.yaml');

    expect(seedBaseFilePaths).toContain('.kortix/opencode/tools/show.ts');
    expect(seedBaseFilePaths).toContain('.kortix/opencode/plugins/pty.ts');
    expect(seedBaseFilePaths).toContain('.kortix/opencode/tools/web_search.ts');
    expect(seedBaseFilePaths).toContain('.kortix/opencode/tools/lib/get-env.ts');
    expect(seedBaseFilePaths).not.toContain('registry-lock.json');

    // The bug this route fix closes: the base template's kortix.yaml declares
    // `default_agent: kortix`, but workspace.metadata.default_agent was never
    // mirrored from it — so every session silently stored the non-binding
    // 'default' sentinel and any agent-scope model pin set on 'kortix' was
    // never applied (see llm-gateway/resolution/default-model.ts). Provision
    // must now stamp the mirror at creation time.
    expect(updatedWorkspaceSets).toHaveLength(1);
    expect(updatedWorkspaceSets[0].metadata.queryChunks).toContain(
      '{"default_agent":"kortix"}',
    );
  });

  test('returns 503 when managed git is not configured', async () => {
    backendConfigured = false;
    const app = createApp();
    const res = await app.request('/v1/workspaces/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent' }),
    });
    expect(res.status).toBe(503);
    expect(backendCalls).toHaveLength(0);
  });

  test('rejects an unsupported provider', async () => {
    const app = createApp();
    const res = await app.request('/v1/workspaces/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, name: 'My Agent', provider: 'gitlab' }),
    });
    expect(res.status).toBe(400);
  });
});

// GET /v1/workspaces/managed-git/status — lets the create-workspace UI pre-check
// whether the managed-git ("Create workspace") path is usable before hitting
// the 503, so it can disable/annotate that option gracefully instead of
// surfacing a raw server error (self-host with no MANAGED_GIT_* configured is
// the primary case this exists for).
describe('GET /v1/workspaces/managed-git/status', () => {
  beforeEach(() => {
    setTestAuth();
    backendConfigured = true;
  });

  test('reports configured: true when the managed backend is configured', async () => {
    const res = await createApp().request('/v1/workspaces/managed-git/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, provider: 'github' });
  });

  test('reports configured: false when the managed backend is not configured', async () => {
    backendConfigured = false;
    const res = await createApp().request('/v1/workspaces/managed-git/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, provider: 'github' });
  });
});
