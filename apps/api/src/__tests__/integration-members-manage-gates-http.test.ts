import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountGroups,
  accountMembers,
  accounts,
  creditAccounts,
  iamPolicies,
  iamRoleActions,
  iamRoles,
  workspaceGroupGrants,
  workspaceMembers,
  workspaces,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { WORKSPACE_ACTIONS } from '../iam';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

// These endpoints are the workspace-scoped members-governance surface (group
// grants, resource grants, approvals, access requests). Each already asserts
// the workspace.members.manage leaf — but the coarse floor was
// loadWorkspaceForUser(..,'manage'), which maps to workspace.write. That OVER-GATED
// them: a custom "member manager" role (workspace.read + members.manage, but NOT
// workspace.write) was wrongly denied at the floor before its members.manage
// grant was ever consulted. The fix lowers the floor to 'read' so the
// members.manage leaf is the sole capability gate. (GET /access-requests also
// GAINED the leaf assert — it previously ran on the floor alone, so a plain
// editor could list pending requests; now it's manager-only like its siblings.)
const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const EDITOR = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
// The custom-role principal: no built-in workspace role at all — access is purely
// an iam_policies grant of [workspace.read, workspace.members.manage] at workspace
// scope. This is the exact role the granular RBAC model must support, and the
// exact case the old 'manage' floor broke.
const CUSTOM = crypto.randomUUID();
const CUSTOM_ROLE = crypto.randomUUID();
const GROUP = crypto.randomUUID();

const minted: string[] = [];

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'members-manage-gate-test' });
  await db.insert(creditAccounts).values({
    accountId: ACCOUNT,
    demoEnterprise: true,
  });
  await db.insert(workspaces).values({
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    name: 'members-manage-gate-test-workspace',
    repoUrl: 'https://example.com/members-manage-gate-test.git',
  });
  await db.insert(accountGroups).values({
    groupId: GROUP,
    accountId: ACCOUNT,
    name: 'session-contract-regression-group',
    createdBy: MANAGER,
  });
  await db.insert(accountMembers).values([
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: EDITOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: CUSTOM, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(workspaceMembers).values([
    { accountId: ACCOUNT, workspaceId: WORKSPACE, userId: MANAGER, workspaceRole: 'manager' },
    { accountId: ACCOUNT, workspaceId: WORKSPACE, userId: EDITOR, workspaceRole: 'editor' },
    { accountId: ACCOUNT, workspaceId: WORKSPACE, userId: MEMBER, workspaceRole: 'member' },
  ]);
  // Custom "member manager" role — members.manage WITHOUT workspace.write.
  await db.insert(iamRoles).values({
    roleId: CUSTOM_ROLE,
    accountId: ACCOUNT,
    key: `mm-${CUSTOM_ROLE.slice(0, 6)}`,
    name: 'Member Manager',
    scopeType: 'workspace',
  });
  await db.insert(iamRoleActions).values([
    { roleId: CUSTOM_ROLE, action: WORKSPACE_ACTIONS.WORKSPACE_READ },
    { roleId: CUSTOM_ROLE, action: WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE },
  ]);
  await db.insert(iamPolicies).values({
    accountId: ACCOUNT,
    principalType: 'member',
    principalId: CUSTOM,
    roleId: CUSTOM_ROLE,
    scopeType: 'workspace',
    scopeId: WORKSPACE,
  });
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(iamPolicies).where(eq(iamPolicies.accountId, ACCOUNT));
  await db.delete(iamRoleActions).where(eq(iamRoleActions.roleId, CUSTOM_ROLE));
  await db.delete(iamRoles).where(eq(iamRoles.accountId, ACCOUNT));
  await db.delete(workspaceGroupGrants).where(eq(workspaceGroupGrants.accountId, ACCOUNT));
  await db.delete(accountGroups).where(eq(accountGroups.accountId, ACCOUNT));
  await db.delete(workspaces).where(eq(workspaces.accountId, ACCOUNT));
  await db.delete(creditAccounts).where(eq(creditAccounts.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function mint(userId: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    workspaceId: WORKSPACE,
    name: 'members-manage-gate-test',
    agentGrant: null as any,
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

// Was the request denied by the RBAC capability gate? Every IAM denial throws a
// "You don't have permission …" 403 (see humanizePermissionDenial in
// iam/dispatcher.ts — members.manage renders the friendly verb, not the raw
// leaf). Because the floor is now 'read' (which ALL four principals hold), the
// only 403 an editor/member can hit on these routes is the members.manage
// assert, and none of these routes entitlement-403 the free test account — so a
// "permission" 403 here is unambiguously the members.manage gate. 400/404 (bad
// body / missing resource) come only AFTER the gate passes.
async function deniedByLeaf(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = await res.json().catch(() => ({}));
  return JSON.stringify(body).toLowerCase().includes('permission');
}

interface EP {
  name: string;
  method: string;
  path: () => string;
  body?: unknown;
}

const ENDPOINTS: EP[] = [
  { name: 'POST /group-grants', method: 'POST', path: () => `/v1/workspaces/${WORKSPACE}/group-grants`, body: {} },
  { name: 'PATCH /group-grants/{id}', method: 'PATCH', path: () => `/v1/workspaces/${WORKSPACE}/group-grants/${crypto.randomUUID()}`, body: {} },
  { name: 'DELETE /group-grants/{id}', method: 'DELETE', path: () => `/v1/workspaces/${WORKSPACE}/group-grants/${crypto.randomUUID()}` },
  { name: 'GET /approvals', method: 'GET', path: () => `/v1/workspaces/${WORKSPACE}/approvals` },
  { name: 'GET /resource-grants', method: 'GET', path: () => `/v1/workspaces/${WORKSPACE}/resource-grants` },
  { name: 'POST /resource-grants', method: 'POST', path: () => `/v1/workspaces/${WORKSPACE}/resource-grants`, body: {} },
  { name: 'DELETE /resource-grants/{id}', method: 'DELETE', path: () => `/v1/workspaces/${WORKSPACE}/resource-grants/${crypto.randomUUID()}` },
  { name: 'GET /access-requests', method: 'GET', path: () => `/v1/workspaces/${WORKSPACE}/access-requests` },
];

describe('HTTP enforcement — workspace members.manage gates (floor lowered read; leaf is the gate)', () => {
  test('a normal group-grant body remains valid and creates the grant', async () => {
    const secret = await mint(MANAGER);
    const res = await req(
      'POST',
      `/v1/workspaces/${WORKSPACE}/group-grants`,
      secret,
      { group_id: GROUP, role: 'editor' },
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      workspace_id: WORKSPACE,
      group_id: GROUP,
      role: 'editor',
    });
  });

  for (const ep of ENDPOINTS) {
    describe(ep.name, () => {
      test('EDITOR (workspace.write but NOT members.manage) → 403 on the members.manage leaf', async () => {
        const secret = await mint(EDITOR);
        const res = await req(ep.method, ep.path(), secret, ep.body);
        expect(await deniedByLeaf(res)).toBe(true);
      });

      test('MEMBER (floor role) → 403 on the members.manage leaf', async () => {
        const secret = await mint(MEMBER);
        const res = await req(ep.method, ep.path(), secret, ep.body);
        expect(await deniedByLeaf(res)).toBe(true);
      });

      test('MANAGER (has members.manage) → NOT denied by the leaf gate', async () => {
        const secret = await mint(MANAGER);
        const res = await req(ep.method, ep.path(), secret, ep.body);
        expect(await deniedByLeaf(res)).toBe(false);
      });

      test('custom role [workspace.read + members.manage], NO workspace.write → NOT denied (over-gating fixed)', async () => {
        const secret = await mint(CUSTOM);
        const res = await req(ep.method, ep.path(), secret, ep.body);
        expect(await deniedByLeaf(res)).toBe(false);
      });
    });
  }
});
