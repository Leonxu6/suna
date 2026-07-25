import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Two workspaces under the same account, each with its own sandbox — this is
// the exact shape the security bug needs: a workspace-scoped PAT for workspace A
// hitting workspace B's sandbox must be 403'd even though both workspaces (and
// both sandboxes) belong to the same account.
const WORKSPACE_A = 'workspace-aaa';
const WORKSPACE_B = 'workspace-bbb';
const SANDBOX_A = 'sandbox-for-a';
const SANDBOX_B = 'sandbox-for-b';
const ACCOUNT = 'acct-shared';

const sandboxWorkspaceByOwnSandboxId: Record<string, string> = {
  [SANDBOX_A]: WORKSPACE_A,
  [SANDBOX_B]: WORKSPACE_B,
};

mock.module('../shared/crypto', () => ({
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (t: string) => {
    if (t === 'kortix_pat_workspace_a') {
      return {
        isValid: true,
        userId: 'user-1',
        accountId: ACCOUNT,
        workspaceId: WORKSPACE_A,
        tokenId: 'tok-a',
      };
    }
    if (t === 'kortix_pat_account_scoped') {
      return {
        isValid: true,
        userId: 'user-1',
        accountId: ACCOUNT,
        tokenId: 'tok-account',
      };
    }
    return { isValid: false, error: 'Invalid PAT' };
  },
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
}));

mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async () => ({ isValid: false, error: 'Invalid Kortix token' }),
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async () => ({ ok: false, reason: 'no-keys' }),
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
  }),
}));

// Sandbox → workspace resolution, keyed by sandboxId the same way the real
// session_sandboxes lookup would be (uuid/externalId → workspace_id).
mock.module('../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async () => true,
  resolveSandboxWorkspaceId: async (sandboxId: string) =>
    sandboxWorkspaceByOwnSandboxId[sandboxId] ?? null,
}));

mock.module('../shared/auth-audit', () => ({
  auditLoginSuccess: () => {},
  auditLoginFail: () => {},
}));

mock.module('../lib/sentry', () => ({ setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ syncSsoMembership: async () => {} }));

const { combinedAuth } = await import('./auth');

function appWithProbe() {
  const app = new Hono();
  app.use('/*', combinedAuth);
  app.get('/v1/p/:sandboxId/:port/*', (c) =>
    c.json({
      userId: c.get('userId' as never),
      tokenWorkspaceId: c.get('tokenWorkspaceId' as never),
    }),
  );
  app.get('/v1/workspaces/:workspaceId', (c) =>
    c.json({ userId: c.get('userId' as never), workspaceId: c.req.param('workspaceId') }),
  );
  return app;
}

describe('workspace-scoped PAT on the sandbox-proxy path', () => {
  beforeEach(() => {});

  test('CAN drive its own workspace sandbox via /v1/p/{sandboxId}/{port}/...', async () => {
    const res = await appWithProbe().request(`/v1/p/${SANDBOX_A}/8000/turn-stream`, {
      headers: { Authorization: 'Bearer kortix_pat_workspace_a' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-1');
    expect(body.tokenWorkspaceId).toBe(WORKSPACE_A);
  });

  test("CANNOT reach another workspace's sandbox (403, cross-workspace blocked)", async () => {
    const res = await appWithProbe().request(`/v1/p/${SANDBOX_B}/8000/turn-stream`, {
      headers: { Authorization: 'Bearer kortix_pat_workspace_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain(
      'Workspace-scoped token cannot access a sandbox outside its workspace',
    );
  });

  test('a sandbox lookup miss also denies (fail closed, not fail open)', async () => {
    const res = await appWithProbe().request('/v1/p/unknown-sandbox/8000/turn-stream', {
      headers: { Authorization: 'Bearer kortix_pat_workspace_a' },
    });

    expect(res.status).toBe(403);
  });

  test('workspace-scoped PAT still cannot call unrelated account-level surfaces', async () => {
    const res = await appWithProbe().request('/v1/accounts', {
      headers: { Authorization: 'Bearer kortix_pat_workspace_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Workspace-scoped token cannot call account-level routes');
  });

  test('workspace-scoped PAT still works unchanged on its own /v1/workspaces/:id/* REST routes', async () => {
    const res = await appWithProbe().request(`/v1/workspaces/${WORKSPACE_A}`, {
      headers: { Authorization: 'Bearer kortix_pat_workspace_a' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(WORKSPACE_A);
  });

  test('account-scoped PAT (no workspace binding) reaches the sandbox proxy unchanged', async () => {
    const res = await appWithProbe().request(`/v1/p/${SANDBOX_A}/8000/turn-stream`, {
      headers: { Authorization: 'Bearer kortix_pat_account_scoped' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-1');
    expect(body.tokenWorkspaceId).toBeFalsy();
  });
});
