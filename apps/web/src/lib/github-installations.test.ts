import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { githubInstallationLabel, isGitHubAppInstallationId } from './github-installations';

describe('GitHub installation presentation', () => {
  test('separates real GitHub App installations from the managed PAT fallback', () => {
    expect(isGitHubAppInstallationId('123456')).toBe(true);
    expect(isGitHubAppInstallationId('pat')).toBe(false);
    expect(isGitHubAppInstallationId(null)).toBe(false);
  });

  test('labels the managed PAT fallback as a server connection', () => {
    expect(githubInstallationLabel('pat', 'kortixd')).toBe('Managed GitHub · github.com/kortixd');
    expect(githubInstallationLabel('123456', 'acme')).toBe('github.com/acme');
  });
});

describe('GitHub account connection surfaces', () => {
  const workspaceModalSource = readFileSync(
    join(import.meta.dir, '../features/workspaces/modal/workspace-create-modal.tsx'),
    'utf8',
  );
  const accountPageSource = readFileSync(
    join(import.meta.dir, '../app/(app)/accounts/[id]/page.tsx'),
    'utf8',
  );

  test('keeps the GitHub App install action visible during repository import', () => {
    expect(workspaceModalSource).toContain('aria-label="Connect another GitHub account"');
    expect(workspaceModalSource).toContain('router.push(`/github/setup?account_id=');
    expect(workspaceModalSource).not.toContain('window.location.assign(freshInstallUrl)');
  });

  test('presents the three repository sources as one visible decision', () => {
    expect(workspaceModalSource).toContain('aria-label="Repository source"');
    expect(workspaceModalSource).toContain('Kortix managed');
    expect(workspaceModalSource).toContain('Create in GitHub');
    expect(workspaceModalSource).toContain('Import from GitHub');
    expect(workspaceModalSource).not.toContain('Use managed repository');
  });

  test('does not gate account GitHub connections on managed-server status', () => {
    expect(accountPageSource).not.toContain("githubAppStatusQuery.data?.source === 'env'");
    expect(accountPageSource).toContain(
      '<GitHubConnectionCard account={account} canManage={canWriteAccount} />',
    );
  });
});
