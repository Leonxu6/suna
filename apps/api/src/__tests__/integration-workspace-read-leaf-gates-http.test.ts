import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, workspaceMembers, workspaces } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { WORKSPACE_ACTIONS } from '../iam';

const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
// A second principal on the SAME workspace with the 'editor' role — the floor
// `member` role has most READ leaves but NOT file.read / secret.read / any write
// (those are editor+), so the "human/legacy token with no agent grant still
// passes" cases for those routes need an editor, not the floor member.
const EDITOR = crypto.randomUUID();

const minted: string[] = [];

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'leaf-gate-http-test' });
  await db.insert(workspaces).values({
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    name: 'leaf-gate-http-test-workspace',
    repoUrl: 'https://example.com/leaf-gate-http-test.git',
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

async function mintToken(agentGrant: unknown): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId: MEMBER,
    workspaceId: WORKSPACE,
    name: 'leaf-gate-http-test',
    agentGrant: agentGrant as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function mintEditorToken(agentGrant: unknown): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId: EDITOR,
    workspaceId: WORKSPACE,
    name: 'leaf-gate-http-test-editor',
    agentGrant: agentGrant as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function getReq(path: string, secret: string) {
  return app.request(path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
}

function postReq(path: string, secret: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Case {
  name: string;
  leaf: string;
  path: () => string;
}

const CASES: Case[] = [
  { name: 'gateway logs', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_LOGS_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/logs` },
  { name: 'gateway errors', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_LOGS_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/errors` },
  { name: 'gateway overview', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/overview` },
  { name: 'gateway series', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/series` },
  { name: 'gateway sessions (per-session spend)', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/sessions` },
  { name: 'gateway breakdown', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/breakdown` },
  { name: 'gateway budgets', leaf: WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ, path: () => `/v1/workspaces/${WORKSPACE}/gateway/budgets` },
  { name: 'workspace sessions list', leaf: WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ, path: () => `/v1/workspaces/${WORKSPACE}/sessions` },
  { name: 'workspace session detail', leaf: WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ, path: () => `/v1/workspaces/${WORKSPACE}/sessions/${crypto.randomUUID()}` },
  { name: 'workspace session transcript', leaf: WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ, path: () => `/v1/workspaces/${WORKSPACE}/sessions/${crypto.randomUUID()}/transcript` },
  { name: 'workspace session audit', leaf: WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ, path: () => `/v1/workspaces/${WORKSPACE}/sessions/${crypto.randomUUID()}/audit` },
  { name: 'workspace access list', leaf: WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_READ, path: () => `/v1/workspaces/${WORKSPACE}/access` },
  { name: 'oauth credentials list', leaf: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ, path: () => `/v1/workspaces/${WORKSPACE}/oauth` },
  { name: 'review items inbox', leaf: WORKSPACE_ACTIONS.WORKSPACE_REVIEW_READ, path: () => `/v1/workspaces/${WORKSPACE}/review/items` },
  { name: 'branches', leaf: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ, path: () => `/v1/workspaces/${WORKSPACE}/branches` },
  { name: 'commits', leaf: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ, path: () => `/v1/workspaces/${WORKSPACE}/commits` },
  { name: 'commit detail', leaf: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ, path: () => `/v1/workspaces/${WORKSPACE}/commits/deadbeef` },
  { name: 'commit diff', leaf: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ, path: () => `/v1/workspaces/${WORKSPACE}/commits/deadbeef/diff` },
  { name: 'version diff', leaf: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ, path: () => `/v1/workspaces/${WORKSPACE}/version-diff?from=a&into=b` },
  { name: 'triggers list', leaf: WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_READ, path: () => `/v1/workspaces/${WORKSPACE}/triggers` },
];

// EDITOR-TIER reads: workspace.file.read + workspace.secret.read were moved OUT of
// the floor `member` role into editor, so a bare member is 403 here (they can
// run the agent/chat but not browse the file tree or view secret values); an
// editor passes. Same agent-grant fold as the member-tier CASES above.
const EDITOR_TIER_READ_CASES: Case[] = [
  { name: 'files list', leaf: WORKSPACE_ACTIONS.WORKSPACE_FILE_READ, path: () => `/v1/workspaces/${WORKSPACE}/files` },
  { name: 'files archive', leaf: WORKSPACE_ACTIONS.WORKSPACE_FILE_READ, path: () => `/v1/workspaces/${WORKSPACE}/files/archive` },
  { name: 'files search', leaf: WORKSPACE_ACTIONS.WORKSPACE_FILE_READ, path: () => `/v1/workspaces/${WORKSPACE}/files/search?q=x` },
  { name: 'files content', leaf: WORKSPACE_ACTIONS.WORKSPACE_FILE_READ, path: () => `/v1/workspaces/${WORKSPACE}/files/content?path=README.md` },
  { name: 'files history', leaf: WORKSPACE_ACTIONS.WORKSPACE_FILE_READ, path: () => `/v1/workspaces/${WORKSPACE}/files/history?path=README.md` },
  { name: 'secrets list', leaf: WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ, path: () => `/v1/workspaces/${WORKSPACE}/secrets` },
];

describe('HTTP enforcement — workspace read-leaf gates (agent-grant fold now reachable)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test('agent granted an UNRELATED capability → 403 (leaf missing from kortix_cli)', async () => {
        const secret = await mintToken({ agent: 'scoped-bot', kortixCli: ['workspace.trigger.fire'], connectors: [] });
        const res = await getReq(c.path(), secret);
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('agent granted the exact leaf → passes the gate (not 403)', async () => {
        const secret = await mintToken({ agent: 'scoped-bot', kortixCli: [c.leaf], connectors: [] });
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });

      test('full-role member token with NO grant (human/legacy) → passes the gate (not 403)', async () => {
        const secret = await mintToken(null);
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });
    });
  }
});

describe('HTTP enforcement — gateway playground spend gate', () => {
  test('agent granted an UNRELATED capability → 403 before upstream dispatch', async () => {
    const secret = await mintToken({ agent: 'scoped-bot', kortixCli: ['workspace.trigger.fire'], connectors: [] });
    const res = await postReq(`/v1/workspaces/${WORKSPACE}/gateway/playground`, secret, {
      prompt: 'hello',
      models: ['not-a-real-model'],
    });
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).toContain(WORKSPACE_ACTIONS.WORKSPACE_GATEWAY_SPEND_READ);
  });
});

describe('HTTP enforcement — editor-tier read gates (file.read / secret.read moved off member)', () => {
  for (const c of EDITOR_TIER_READ_CASES) {
    describe(c.name, () => {
      test('floor MEMBER (no file/secret read) → 403', async () => {
        const secret = await mintToken(null);
        const res = await getReq(c.path(), secret);
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('EDITOR (has the read leaf) → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken(null);
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });

      test('agent (editor) granted the exact leaf → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken({ agent: 'scoped-bot', kortixCli: [c.leaf], connectors: [] });
        const res = await getReq(c.path(), secret);
        expect(res.status).not.toBe(403);
      });
    });
  }
});

// TIER-1 SECURITY — these two are SEND primitives (post an arbitrary file to
// Slack / make the meeting bot speak) that used to be gated by nothing but
// loadWorkspaceForUser(..,'read') — any workspace-read caller could invoke them.
// Fixed by asserting workspace.connector.write (the same leaf that already
// gates Slack connect/disconnect and the channel-bindings route) instead of
// wiring the dead/unwired channel.send catalog leaf.
const SEND_PRIMITIVE_CASES: Case[] = [
  {
    name: 'slack file upload proxy',
    leaf: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,
    path: () => `/v1/workspaces/${WORKSPACE}/channels/slack/file/upload`,
  },
  {
    name: 'meet speak proxy',
    leaf: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,
    path: () => `/v1/workspaces/${WORKSPACE}/channels/meet/speak`,
  },
  {
    // Teams consent-card upload drives the workspace bot to SEND into the
    // customer's Teams channel — the same send primitive as Slack upload; the
    // capability assert runs before teamsChannelEnabled(), so the 403 fires
    // regardless of whether Teams is enabled in this harness.
    name: 'teams file upload consent card',
    leaf: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,
    path: () => `/v1/workspaces/${WORKSPACE}/channels/teams/file/upload`,
  },
];

describe('HTTP enforcement — send-primitive gates (Slack upload / meet speak)', () => {
  for (const c of SEND_PRIMITIVE_CASES) {
    describe(c.name, () => {
      test('floor MEMBER (workspace-read, no connector.write) → 403 — the exact vulnerability the audit found', async () => {
        // Before this fix, a bare loadWorkspaceForUser(..,'read') gate let ANY
        // workspace-read caller — including the floor `member` role — hit this
        // send primitive. Deliberately empty body: the IAM gate must fire
        // before body validation.
        const secret = await mintToken(null);
        const res = await postReq(c.path(), secret, {});
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('EDITOR (has connector.write) → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken(null);
        const res = await postReq(c.path(), secret, {});
        expect(res.status).not.toBe(403);
      });

      test('scoped agent launched by an editor but missing connector.write in kortix_cli → 403', async () => {
        const secret = await mintEditorToken({ agent: 'scoped-bot', kortixCli: ['workspace.trigger.fire'], connectors: [] });
        const res = await postReq(c.path(), secret, {});
        expect(res.status).toBe(403);
        const body = await res.json().catch(() => ({}));
        expect(JSON.stringify(body)).toContain(c.leaf);
      });

      test('scoped agent launched by an editor AND granted connector.write → passes the gate (not 403)', async () => {
        const secret = await mintEditorToken({ agent: 'scoped-bot', kortixCli: [c.leaf], connectors: [] });
        const res = await postReq(c.path(), secret, {});
        expect(res.status).not.toBe(403);
      });
    });
  }
});
