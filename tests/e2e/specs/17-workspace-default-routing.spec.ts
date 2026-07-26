import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';
import { runSqlWithSelfHostFallback } from '../helpers/self-host';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = 'E2eWorkspaceRouting123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  name: string;
  default_workspace_id: string | null;
}

interface AuthUser {
  id: string;
}

function seedWorkspace(
  accountId: string,
  workspaceId: string,
  name: string,
  makeDefault: boolean,
): void {
  runSqlWithSelfHostFallback(`
insert into kortix.projects (
  project_id,
  account_id,
  name,
  repo_url,
  default_branch,
  manifest_path,
  status,
  metadata
) values (
  '${workspaceId}'::uuid,
  '${accountId}'::uuid,
  '${name}',
  'https://example.invalid/${workspaceId}.git',
  'main',
  'kortix.yaml',
  'active',
  '{"workspace_routing_e2e":true,"onboarding_completed_at":"2026-01-01T00:00:00.000Z"}'::jsonb
);
${makeDefault ? `update kortix.accounts set default_workspace_id = '${workspaceId}'::uuid, setup_complete_at = now(), setup_wizard_step = 0 where account_id = '${accountId}'::uuid;` : ''}
`);
}

test.describe('Workspace default routing', () => {
  let user: AuthUser;
  let session: AuthSession;
  let primaryAccountId: string;
  let secondaryAccountId: string;
  const defaultWorkspaceId = randomUUID();
  const additionalWorkspaceId = randomUUID();
  const secondaryDefaultWorkspaceId = randomUUID();

  test.beforeAll(async () => {
    const email = `workspace-routing-${randomUUID()}@kortix.local`;
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);

    const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
    primaryAccountId = accounts[0]!.account_id;
    seedWorkspace(primaryAccountId, defaultWorkspaceId, 'Default Workspace', true);

    const secondaryAccount = await api<AccountSummary>(
      session.access_token,
      'POST',
      '/accounts',
      { name: 'Secondary Account' },
      201,
    );
    secondaryAccountId = secondaryAccount.account_id;
    seedWorkspace(
      secondaryAccountId,
      secondaryDefaultWorkspaceId,
      'Secondary Default Workspace',
      true,
    );
  });

  test.afterAll(async () => {
    if (primaryAccountId && secondaryAccountId) {
      runSqlWithSelfHostFallback(`
delete from kortix.accounts
where account_id in ('${primaryAccountId}'::uuid, '${secondaryAccountId}'::uuid);
`);
    }
    if (user?.id) {
      await deleteAuthUser(user.id, { supabaseUrl });
    }
  });

  test('opens each account default and exposes management only when needed', async ({ page }) => {
    const workspaceRequests: string[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/v1/workspaces') && response.status() < 500) {
        workspaceRequests.push(url.pathname);
      }
    });

    await installBrowserSession(page, session, '/workspaces', password);
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${defaultWorkspaceId}(?:\\?.*)?$`),
      { timeout: 30_000 },
    );
    await expect(page.getByText('Default Workspace', { exact: true }).first()).toBeVisible();
    await expect.poll(() => workspaceRequests.length).toBeGreaterThan(0);
    expect(workspaceRequests.every((path) => !path.startsWith('/v1/projects'))).toBe(true);

    const workspaceSwitcher = page.getByRole('button', { name: /Default Workspace/ });
    await expect(workspaceSwitcher).toHaveCount(0);

    await page.goto(`/projects/${defaultWorkspaceId}?from=legacy`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${defaultWorkspaceId}\\?from=legacy$`),
      { timeout: 30_000 },
    );

    seedWorkspace(primaryAccountId, additionalWorkspaceId, 'Additional Workspace', false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(workspaceSwitcher).toBeVisible({ timeout: 30_000 });
    await workspaceSwitcher.click();
    await page.getByRole('menuitem', { name: /Additional Workspace/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${additionalWorkspaceId}(?:\\?.*)?$`),
      { timeout: 30_000 },
    );

    const userMenu = page
      .getByRole('button', { name: new RegExp(session.user.email || '', 'i') })
      .first();
    await userMenu.click();
    await page.getByRole('menuitem').filter({ hasText: /Account settings/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/accounts/${primaryAccountId}(?:\\?.*)?$`),
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /^Workspaces$/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/accounts/${primaryAccountId}/workspaces(?:\\?.*)?$`),
      { timeout: 30_000 },
    );
    await expect(page.getByRole('heading', { name: /Workspaces/i }).first()).toBeVisible();

    const accountSwitcher = page.getByRole('button', { name: /Switch account/i }).first();
    await accountSwitcher.click();
    await page.getByRole('menuitem', { name: /Secondary Account/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${secondaryDefaultWorkspaceId}(?:\\?.*)?$`),
      { timeout: 30_000 },
    );
  });
});
