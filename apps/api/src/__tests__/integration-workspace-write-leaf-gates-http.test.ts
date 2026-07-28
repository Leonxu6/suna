import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, workspaceMembers, workspaces } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WORKSPACE_ACTIONS } from '../iam';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

const { workspacesApp } = await import('../workspaces');
const app = new Hono();
app.route('/v1/workspaces', workspacesApp);
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: true, message: err.message, status: err.status }, err.status);
  }
  return c.json({ error: true, message: (err as Error).message }, 500);
});

// Every capability checkbox must be authoritative: unchecking a leaf must DENY
// its endpoint. These endpoints previously gated on a coarse floor only (or an
// agent-scope check that is a no-op for humans), so unchecking the leaf did
// nothing. This suite proves each newly-added leaf gate fires, using the
// agent-grant fold: a scoped agent token restricts the launching user to the
// leaves in its kortix_cli grant (workspace.read/workspace.write are exempt — see
// AGENT_GRANT_EXEMPT_ACTIONS — so the coarse floor always passes and only the
// specific leaf gate is under test).
const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const EDITOR = crypto.randomUUID();

const minted: string[] = [];

beforeAll(async () => {
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'write-leaf-gate-test' });
  await db.insert(workspaces).values({
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    name: 'write-leaf-gate-test-workspace',
    repoUrl: 'https://example.com/write-leaf-gate-test.git',
  });
  await db.insert(accountMembers).values([
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: EDITOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(workspaceMembers).values([
    { accountId: ACCOUNT, workspaceId: WORKSPACE, userId: MEMBER, workspaceRole: 'member' },
    { accountId: ACCOUNT, workspaceId: WORKSPACE, userId: EDITOR, workspaceRole: 'editor' },
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(workspaces).where(eq(workspaces.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function mint(userId: string, kortixCli: string[] | null): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    workspaceId: WORKSPACE,
    name: 'write-leaf-gate-test',
    agentGrant: kortixCli ? { agent: 'scoped-bot', kortixCli, connectors: [] } : null,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function req(method: string, path: string, secret: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// An IAM denial (403) from either loadWorkspaceForUser (floor) or
// assertWorkspaceCapability (leaf). Both phrase it distinctively; a non-IAM 403
// (e.g. the "email is experimental" gate) matches none of these, so the ALLOW
// cases can still 403 for an unrelated reason without being counted as a leaf
// denial.
async function iamDenied(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const text = JSON.stringify(await res.json().catch(() => ({})));
  return /permission|do not have access|doesn't let you|not granted/i.test(text);
}

interface WCase {
  name: string;
  leaf: string;
  method: string;
  path: () => string;
  body?: unknown;
  // 'member' = the floor role holds this leaf (so a plain member passes);
  // 'editor' = editor-tier (a plain member is denied, an editor passes).
  tier: 'member' | 'editor';
  // kortix_cli grants for the agent-grant fold. deny = a grant that should be
  // rejected by the leaf gate; allow = the exact grant that should pass it.
  denyGrant: string[];
  allowGrant: string[];
}

const A = WORKSPACE_ACTIONS;
const sid = () => crypto.randomUUID();

const CASES: WCase[] = [
  // ── Session lifecycle ────────────────────────────────────────────────────
  {
    name: 'session start (floor session.start)',
    leaf: A.WORKSPACE_SESSION_START,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/sessions/${sid()}/start`,
    tier: 'member',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_SESSION_START],
  },
  {
    name: 'session stop (leaf session.stop)',
    leaf: A.WORKSPACE_SESSION_STOP,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/sessions/${sid()}/stop`,
    tier: 'member',
    // floor is session.start, so the deny grant must hold start (to reach the
    // stop assert) but not stop.
    denyGrant: [A.WORKSPACE_SESSION_START],
    allowGrant: [A.WORKSPACE_SESSION_START, A.WORKSPACE_SESSION_STOP],
  },
  {
    name: 'session model change (leaf session.stop)',
    leaf: A.WORKSPACE_SESSION_STOP,
    method: 'PUT',
    path: () => `/v1/workspaces/${WORKSPACE}/sessions/${sid()}/model`,
    body: { opencode_model: 'openai/gpt-5' },
    tier: 'member',
    // A live model change restarts opencode, so the scoped token must hold the
    // same destructive capability as the stop route.
    denyGrant: [A.WORKSPACE_SESSION_START],
    allowGrant: [A.WORKSPACE_SESSION_START, A.WORKSPACE_SESSION_STOP],
  },
  // ── Review ───────────────────────────────────────────────────────────────
  {
    name: 'CR request-changes (review.act, not gitops.push)',
    leaf: A.WORKSPACE_REVIEW_ACT,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/change-requests/${sid()}/request-changes`,
    body: {},
    tier: 'editor',
    // deny with gitops.push (the OLD leaf) to prove the gate is now review.act.
    denyGrant: [A.WORKSPACE_GITOPS_PUSH],
    allowGrant: [A.WORKSPACE_REVIEW_ACT],
  },
  {
    name: 'review item submit (review.submit)',
    leaf: A.WORKSPACE_REVIEW_SUBMIT,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/review/items`,
    body: {},
    tier: 'member',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_REVIEW_SUBMIT],
  },
  // ── Triggers ─────────────────────────────────────────────────────────────
  {
    // Floor was 'manage' (workspace.write) — which the floor `member` role lacks
    // though it HOLDS trigger.fire, so a plain member could never fire. Floor is
    // now 'read', so the trigger.fire leaf is the gate and member can fire.
    name: 'trigger fire (trigger.fire — member floor role must be able to fire)',
    leaf: A.WORKSPACE_TRIGGER_FIRE,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/triggers/some-slug/fire`,
    body: {},
    tier: 'member',
    denyGrant: [A.WORKSPACE_SESSION_START],
    allowGrant: [A.WORKSPACE_TRIGGER_FIRE],
  },
  // ── Connectors (write) ───────────────────────────────────────────────────
  {
    name: 'email connect (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/email/connect`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  {
    name: 'email installation PATCH (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'PATCH',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/email/installation`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  {
    name: 'email installation DELETE (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'DELETE',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/email/installation`,
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  {
    // Teams disconnect — twin of email installation DELETE; no feature-flag
    // pre-gate, so the connector-write assert is directly exercised. (Teams
    // CONNECT uses the identical assert but sits behind teamsChannelEnabled(),
    // untestable here without the flag; DELETE covers the same code pattern.)
    name: 'teams installation DELETE (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'DELETE',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/teams/installation`,
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  {
    // Binding a Slack thread wires inbound channel→session routing — a
    // connector-write action; empty body reaches the gate before validation.
    name: 'slack bind-thread (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/slack/bind-thread`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  {
    name: 'channel binding PATCH (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'PATCH',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/bindings/${sid()}`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  {
    name: 'connect-requests (connector.write)',
    leaf: A.WORKSPACE_CONNECTOR_WRITE,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/connect-requests`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_WRITE],
  },
  // ── Connectors (read) ────────────────────────────────────────────────────
  {
    name: 'channel bindings list (connector.read)',
    leaf: A.WORKSPACE_CONNECTOR_READ,
    method: 'GET',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/bindings`,
    tier: 'member',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CONNECTOR_READ],
  },
  // ── Customize (write) ────────────────────────────────────────────────────
  {
    name: 'meet bot name (customize.write)',
    leaf: A.WORKSPACE_CUSTOMIZE_WRITE,
    method: 'PUT',
    path: () => `/v1/workspaces/${WORKSPACE}/channels/meet/name`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CUSTOMIZE_WRITE],
  },
  {
    // Strict body (ModelDefaultBody) is validated at the OpenAPI layer BEFORE the
    // handler, so send a schema-valid body — otherwise a 400 pre-empts the gate.
    name: 'model-defaults PUT (customize.write)',
    leaf: A.WORKSPACE_CUSTOMIZE_WRITE,
    method: 'PUT',
    path: () => `/v1/workspaces/${WORKSPACE}/model-defaults`,
    body: { scope: 'workspace', model: 'openai/gpt-4o' },
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CUSTOMIZE_WRITE],
  },
  {
    name: 'model-defaults DELETE (customize.write)',
    leaf: A.WORKSPACE_CUSTOMIZE_WRITE,
    method: 'DELETE',
    path: () => `/v1/workspaces/${WORKSPACE}/model-defaults?scope=workspace`,
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CUSTOMIZE_WRITE],
  },
  {
    name: 'default-agent PUT (customize.write)',
    leaf: A.WORKSPACE_CUSTOMIZE_WRITE,
    method: 'PUT',
    path: () => `/v1/workspaces/${WORKSPACE}/default-agent`,
    body: { agent: 'support' },
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CUSTOMIZE_WRITE],
  },
  {
    name: 'experimental toggle (customize.write)',
    leaf: A.WORKSPACE_CUSTOMIZE_WRITE,
    method: 'PATCH',
    path: () => `/v1/workspaces/${WORKSPACE}/experimental`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CUSTOMIZE_WRITE],
  },
  {
    name: 'sandbox-provider (customize.write)',
    leaf: A.WORKSPACE_CUSTOMIZE_WRITE,
    method: 'PATCH',
    path: () => `/v1/workspaces/${WORKSPACE}/sandbox-provider`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_CUSTOMIZE_WRITE],
  },
  // ── Agent scope (agent.write) ────────────────────────────────────────────
  {
    name: 'agent scope PUT (agent.write)',
    leaf: A.WORKSPACE_AGENT_WRITE,
    method: 'PUT',
    path: () => `/v1/workspaces/${WORKSPACE}/agents/scoped-bot/scope`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_AGENT_WRITE],
  },
  // ── Secrets (write) ──────────────────────────────────────────────────────
  {
    name: 'secret-requests (secret.write)',
    leaf: A.WORKSPACE_SECRET_WRITE,
    method: 'POST',
    path: () => `/v1/workspaces/${WORKSPACE}/secret-requests`,
    body: {},
    tier: 'editor',
    denyGrant: [A.WORKSPACE_TRIGGER_FIRE],
    allowGrant: [A.WORKSPACE_SECRET_WRITE],
  },
];

describe('HTTP enforcement — workspace write/lifecycle leaf gates (every checkbox authoritative)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test('scoped agent with an UNRELATED grant → denied by the leaf gate', async () => {
        const secret = await mint(EDITOR, c.denyGrant);
        const res = await req(c.method, c.path(), secret, c.body);
        expect(await iamDenied(res)).toBe(true);
      });

      test('scoped agent granted the exact leaf → NOT denied by the leaf gate', async () => {
        const secret = await mint(EDITOR, c.allowGrant);
        const res = await req(c.method, c.path(), secret, c.body);
        expect(await iamDenied(res)).toBe(false);
      });

      if (c.tier === 'editor') {
        test('plain MEMBER (lacks the editor-tier leaf) → denied', async () => {
          const secret = await mint(MEMBER, null);
          const res = await req(c.method, c.path(), secret, c.body);
          expect(await iamDenied(res)).toBe(true);
        });
        test('plain EDITOR (holds the leaf) → NOT denied', async () => {
          const secret = await mint(EDITOR, null);
          const res = await req(c.method, c.path(), secret, c.body);
          expect(await iamDenied(res)).toBe(false);
        });
      } else {
        test('plain MEMBER (floor role holds the leaf) → NOT denied', async () => {
          const secret = await mint(MEMBER, null);
          const res = await req(c.method, c.path(), secret, c.body);
          expect(await iamDenied(res)).toBe(false);
        });
      }
    });
  }
});
