import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authHeaders, createApiJsonClient, createApiStatusClient } from '../helpers/http';
import { type AuthSession, createAuthUser, installBrowserSession, signIn } from '../helpers/session-auth';
import { seedSelfHostedWorkspace } from '../helpers/self-host';
import { selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = 'E2eAccountAccess123!';
const api = createApiJsonClient(apiBase);
const apiStatus = createApiStatusClient(apiBase);
const authOptions = { supabaseUrl, password };

type AccountRole = 'owner' | 'admin' | 'member';
type WorkspaceRole = 'manager' | 'editor' | 'user';

interface AccountSummary {
  account_id: string;
  name: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: AccountRole;
}

interface WorkspaceSummary {
  workspace_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  workspace_role: WorkspaceRole | null;
  effective_workspace_role: WorkspaceRole | null;
}

interface AccountMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  explicit_workspace_count?: number;
}

interface InviteResult {
  status: 'added' | 'pending';
  user_id?: string;
  invite_id?: string;
  email: string;
  account_role: AccountRole;
}

interface WorkspaceAccessMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  workspace_role: WorkspaceRole | null;
  effective_workspace_role: WorkspaceRole | null;
  has_implicit_access: boolean;
}

interface WorkspaceAccessResponse {
  workspace_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: WorkspaceAccessMember[];
}

async function createWorkspaceForAccessTest(
  token: string,
  accountId: string,
  ownerUserId: string,
  name: string,
  repoUrl: string,
): Promise<WorkspaceSummary> {
  const response = await fetch(`${apiBase}/workspaces`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      account_id: accountId,
      name,
      repo_url: repoUrl,
      default_branch: 'main',
    }),
  });
  const body = await response.text();
  if (response.status === 201) return JSON.parse(body) as WorkspaceSummary;
  if (response.status === 409 && body.includes('GitHub App installation required')) {
    const workspaceId = seedSelfHostedWorkspace({ accountId, userId: ownerUserId, name, repoUrl });
    return api<WorkspaceSummary>(token, 'GET', `/workspaces/${workspaceId}`);
  }
  throw new Error(`Expected 201/409 from ${response.url}, got ${response.status}: ${body}`);
}

async function dismissWorkspaceOnboarding(page: Page) {
  const onboarding = page.getByRole('dialog', { name: /Workspace onboarding/i });
  if (!(await onboarding.isVisible({ timeout: 5_000 }).catch(() => false))) return;
  await onboarding.getByRole('button', { name: /Skip onboarding/i }).click();
  await expect(onboarding).toHaveCount(0, { timeout: 10_000 });
}

async function openCustomizeSection(
  page: Page,
  workspaceId: string,
  section: string,
  heading: RegExp,
) {
  await page.goto(`/workspaces/${workspaceId}/customize/${section}`, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: /Customize/i });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const targetHeading = page.getByRole('heading', { name: heading });
  if (!(await targetHeading.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await dialog.getByRole('button', { name: new RegExp(`^${section}$`, 'i') }).click();
  }
  await expect(targetHeading).toBeVisible({ timeout: 30_000 });
  return dialog;
}

function byEmail(members: WorkspaceAccessMember[], email: string) {
  return members.find((member) => member.email?.toLowerCase() === email.toLowerCase());
}

function toGitHubWebUrl(repoUrl: string): string {
  return repoUrl
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

test.describe('08 — Accounts, invites, and workspace access', () => {
  test.setTimeout(300_000);

  test('API and web enforce account roles plus workspace-scoped access', async ({ page }) => {
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      const status = response.status();
      const url = response.url();
      if (status >= 500 && (url.includes('/v1/accounts') || url.includes('/v1/workspaces'))) {
        serverErrors.push(`${status} ${url}`);
      }
    });

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const ownerEmail = `e2e-owner-${runId}@example.test`;
    const memberEmail = `e2e-member-${runId}@example.test`;
    const invitedEmail = `e2e-invite-${runId}@example.test`;
    const uiInvitedEmail = `e2e-ui-invite-${runId}@example.test`;
    const accountName = `E2E Org ${runId}`;
    const initialWorkspaceName = `E2E Workspace ${runId}`;

    const owner = await createAuthUser(ownerEmail, authOptions);
    const member = await createAuthUser(memberEmail, authOptions);
    const ownerSession = await signIn(ownerEmail, authOptions);
    const memberSession = await signIn(memberEmail, authOptions);

    const ownerInitialAccounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
    const ownerPersonalAccount = ownerInitialAccounts.find(
      (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
    );
    expect(ownerPersonalAccount).toBeTruthy();
    await api<AccountSummary[]>(memberSession.access_token, 'GET', '/accounts');

    const account = await api<AccountSummary>(
      ownerSession.access_token,
      'POST',
      '/accounts',
      { name: accountName },
      201,
    );
    expect(account.name).toBe(accountName);
    expect(account.account_role).toBe('owner');

    const addedMember = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: memberEmail, role: 'member' },
      201,
    );
    expect(addedMember.status).toBe('added');
    expect(addedMember.user_id).toBe(member.id);

    const pendingInvite = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: invitedEmail, role: 'member' },
      201,
    );
    expect(pendingInvite.status).toBe('pending');
    expect(pendingInvite.invite_id).toBeTruthy();
    const accountInviteId = pendingInvite.invite_id!;

    const memberAccounts = await api<AccountSummary[]>(memberSession.access_token, 'GET', '/accounts');
    expect(memberAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    const workspace = await createWorkspaceForAccessTest(
      ownerSession.access_token,
      account.account_id,
      owner.id,
      initialWorkspaceName,
      `https://github.com/kortix-ai/e2e-${runId}.git`,
    );
    expect(workspace.name).toBe(initialWorkspaceName);
    expect(workspace.workspace_role).toBe('manager');
    expect(workspace.effective_workspace_role).toBe('manager');
    const workspaceRepoWebUrl = toGitHubWebUrl(workspace.repo_url);

    const ownerWorkspaces = await api<WorkspaceSummary[]>(
      ownerSession.access_token,
      'GET',
      `/workspaces?account_id=${account.account_id}`,
    );
    expect(ownerWorkspaces.map((item) => item.workspace_id)).toContain(workspace.workspace_id);

    const memberWorkspacesBeforeGrant = await api<WorkspaceSummary[]>(
      memberSession.access_token,
      'GET',
      `/workspaces?account_id=${account.account_id}`,
    );
    expect(memberWorkspacesBeforeGrant).toEqual([]);
    expect(await apiStatus(memberSession.access_token, 'GET', `/workspaces/${workspace.workspace_id}`)).toBe(403);
    expect(await apiStatus(memberSession.access_token, 'POST', `/workspaces/${workspace.workspace_id}/sessions`, {})).toBe(403);

    const accessBeforeGrant = await api<WorkspaceAccessResponse>(
      ownerSession.access_token,
      'GET',
      `/workspaces/${workspace.workspace_id}/access`,
    );
    expect(accessBeforeGrant.can_manage).toBe(true);
    expect(byEmail(accessBeforeGrant.members, memberEmail)?.workspace_role).toBeNull();
    expect(byEmail(accessBeforeGrant.members, memberEmail)?.effective_workspace_role).toBeNull();

    const viewerGrant = await api<WorkspaceAccessMember>(
      ownerSession.access_token,
      'PUT',
      `/workspaces/${workspace.workspace_id}/access/${member.id}`,
      { role: 'user' },
    );
    expect(viewerGrant.workspace_role).toBe('user');
    expect(viewerGrant.effective_workspace_role).toBe('user');

    const memberWorkspacesAfterGrant = await api<WorkspaceSummary[]>(
      memberSession.access_token,
      'GET',
      `/workspaces?account_id=${account.account_id}`,
    );
    expect(memberWorkspacesAfterGrant.map((item) => item.workspace_id)).toEqual([workspace.workspace_id]);
    const readableWorkspace = await api<WorkspaceSummary>(
      memberSession.access_token,
      'GET',
      `/workspaces/${workspace.workspace_id}`,
    );
    expect(readableWorkspace.effective_workspace_role).toBe('user');
    // A plain user is the floor *usable* role: it can start sessions and use the
    // agent chat (this previously 403'd, which made the floor workspace role useless).
    // It reaches provider validation just like an owner — an invalid provider is a
    // 400, NOT the old role 403 (and avoids actually provisioning a sandbox here).
    expect(await apiStatus(memberSession.access_token, 'POST', `/workspaces/${workspace.workspace_id}/sessions`, { provider: 'justavps' })).toBe(400);
    // ...but it still cannot customize the workspace.
    expect(await apiStatus(memberSession.access_token, 'PATCH', `/workspaces/${workspace.workspace_id}`, { name: 'blocked' })).toBe(403);

    await api<{ ok: true }>(
      ownerSession.access_token,
      'DELETE',
      `/workspaces/${workspace.workspace_id}/access/${member.id}`,
    );
    expect(await apiStatus(memberSession.access_token, 'GET', `/workspaces/${workspace.workspace_id}`)).toBe(403);

    const promoted = await api<{ account_role: AccountRole }>(
      ownerSession.access_token,
      'PATCH',
      `/accounts/${account.account_id}/members/${member.id}`,
      { role: 'admin' },
    );
    expect(promoted.account_role).toBe('admin');

    const adminUpdate = await api<WorkspaceSummary>(
      memberSession.access_token,
      'PATCH',
      `/workspaces/${workspace.workspace_id}`,
      { name: `${initialWorkspaceName} Admin` },
    );
    expect(adminUpdate.effective_workspace_role).toBe('manager');
    expect(adminUpdate.name).toBe(`${initialWorkspaceName} Admin`);

    await api<{ account_role: AccountRole }>(
      ownerSession.access_token,
      'PATCH',
      `/accounts/${account.account_id}/members/${member.id}`,
      { role: 'member' },
    );
    expect(await apiStatus(memberSession.access_token, 'GET', `/workspaces/${workspace.workspace_id}`)).toBe(403);

    await installBrowserSession(page, ownerSession, `/workspaces/${workspace.workspace_id}`, password);
    await selectAccountForUi(page, account.account_id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace.workspace_id}$`));
    await expect(page.getByRole('link', { name: 'Workspaces' }).first()).toHaveAttribute('href', '/workspaces');
    await expect(page.getByRole('button', { name: 'New session' }).first()).toBeVisible();
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Set up workspace/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Customize' }).first()).toBeVisible();
    await expect(page.getByText(ownerSession.user.email!)).toBeVisible();
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Secrets', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Triggers', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Tunnel', { exact: true })).toHaveCount(0);
    await dismissWorkspaceOnboarding(page);
    await page.getByRole('button', { name: 'Customize' }).first().click();
    await expect(page.getByRole('dialog', { name: /Customize/i })).toBeVisible();
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    expect(workspaceRepoWebUrl).toContain('github.com/kortix-ai/');

    await selectAccountForUi(page, account.account_id);
    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await expect(page.getByText(accountName).first()).toBeVisible();

    await installBrowserSession(page, ownerSession, `/accounts/${account.account_id}`, password);
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();
    await expect(page.getByText(memberEmail)).toBeVisible();
    await expect(page.getByText(invitedEmail)).toBeVisible();
    await expect(page.getByText(/Pending invites/i)).toBeVisible();
    const uiInviteResponse = page.waitForResponse((response) =>
      response.url().includes(`/v1/accounts/${account.account_id}/members`) &&
      response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Invite member' }).click();
    await expect(page.getByRole('dialog', { name: 'Invite member' })).toBeVisible();
    await page.getByLabel('Email').fill(uiInvitedEmail);
    await page
      .getByRole('dialog', { name: 'Invite member' })
      .getByRole('button', { name: 'Invite' })
      .click();
    expect((await uiInviteResponse).status()).toBe(201);
    await expect(page.getByText(uiInvitedEmail)).toBeVisible();

    await createAuthUser(uiInvitedEmail, authOptions);
    const uiInvitedSession = await signIn(uiInvitedEmail, authOptions);
    const uiInvitedAccounts = await api<AccountSummary[]>(uiInvitedSession.access_token, 'GET', '/accounts');
    expect(uiInvitedAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    await selectAccountForUi(page, account.account_id);
    const settingsDialog = await openCustomizeSection(page, workspace.workspace_id, 'settings', /^Settings$/i);
    const githubLink = settingsDialog.getByRole('link', { name: /Open on GitHub/i });
    await expect(githubLink).toBeVisible();
    await expect(githubLink).toHaveAttribute('href', workspaceRepoWebUrl);

    const membersDialog = await openCustomizeSection(page, workspace.workspace_id, 'members', /Workspace members/i);
    await membersDialog.getByLabel('Email').fill(memberEmail);
    await membersDialog.locator('#invite-role').click();
    await page.getByRole('option', { name: /User/i }).click();
    const accessInvite = page.waitForResponse((response) =>
      response.url().includes(`/v1/workspaces/${workspace.workspace_id}/access/invite`) &&
      response.request().method() === 'POST',
    );
    await membersDialog.getByRole('button', { name: /^Invite$/i }).click();
    expect((await accessInvite).status()).toBe(200);
    const memberAccessRow = membersDialog.locator('li').filter({ hasText: memberEmail }).first();
    await expect(memberAccessRow).toBeVisible({ timeout: 15_000 });
    await expect(memberAccessRow.getByRole('combobox')).toContainText('User');

    await installBrowserSession(page, memberSession, '/workspaces', password);
    await selectAccountForUi(page, account.account_id);
    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`${initialWorkspaceName} Admin`)).toBeVisible();

    await api<{ ok: true }>(
      ownerSession.access_token,
      'DELETE',
      `/workspaces/${workspace.workspace_id}/access/${member.id}`,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`${initialWorkspaceName} Admin`)).toHaveCount(0);
    await expect(page.getByText(/No workspaces yet/i)).toBeVisible();

    const invitedUser = await createAuthUser(invitedEmail, authOptions);
    const invitedSession = await signIn(invitedEmail, authOptions);
    expect(invitedUser.id).toBeTruthy();
    await installBrowserSession(page, invitedSession, `/invites/${accountInviteId}`, password);
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();
    if (page.url().includes(`/invites/${accountInviteId}`)) {
      await expect(page.getByText(/Team account/i)).toBeVisible();
      const acceptAccountInviteResponse = page.waitForResponse((response) =>
        response.url().includes(`/v1/account-invites/${accountInviteId}/accept`) &&
        response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Accept' }).click();
      expect((await acceptAccountInviteResponse).status()).toBe(200);
    }
    await expect(page).toHaveURL(new RegExp(`/accounts/${account.account_id}`));
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();

    const invitedAccounts = await api<AccountSummary[]>(invitedSession.access_token, 'GET', '/accounts');
    expect(invitedAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    const finalMembers = await api<AccountMember[]>(
      ownerSession.access_token,
      'GET',
      `/accounts/${account.account_id}/members`,
    );
    expect(finalMembers.some((item) => item.email === memberEmail && item.account_role === 'member')).toBe(true);
    expect(finalMembers.some((item) => item.email === invitedEmail && item.account_role === 'member')).toBe(true);
    expect(finalMembers.some((item) => item.email === uiInvitedEmail && item.account_role === 'member')).toBe(true);

    await api<{ ok: true }>(ownerSession.access_token, 'DELETE', `/workspaces/${workspace.workspace_id}`);

    expect(serverErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
