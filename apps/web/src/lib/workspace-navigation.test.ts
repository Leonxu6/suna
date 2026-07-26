import { describe, expect, test } from 'bun:test';

import {
  accountWorkspaceDestination,
  legacyWorkspaceDestination,
  selectAccountWorkspace,
  shouldRenderWorkspaceSwitcher,
  workspaceManagementPath,
} from './workspace-navigation';

const workspaces = [
  { workspace_id: 'workspace-first' },
  { workspace_id: 'workspace-default' },
];

describe('Workspace navigation', () => {
  test('selects the accessible Account default Workspace', () => {
    expect(
      selectAccountWorkspace(
        { default_workspace_id: 'workspace-default' },
        workspaces,
      )?.workspace_id,
    ).toBe('workspace-default');
  });

  test('falls back to the first accessible Workspace when the default is unavailable', () => {
    expect(
      selectAccountWorkspace(
        { default_workspace_id: 'workspace-unavailable' },
        workspaces,
      )?.workspace_id,
    ).toBe('workspace-first');
  });

  test('routes an Account with no accessible Workspace through the resolver', () => {
    expect(accountWorkspaceDestination({ default_workspace_id: null }, [])).toBe('/workspaces');
  });

  test('opens the selected Account default Workspace', () => {
    expect(
      accountWorkspaceDestination(
        { default_workspace_id: 'workspace-default' },
        workspaces,
      ),
    ).toBe('/workspaces/workspace-default');
  });

  test('hides the Workspace switcher only when one Workspace is accessible', () => {
    expect(shouldRenderWorkspaceSwitcher([])).toBe(true);
    expect(shouldRenderWorkspaceSwitcher([workspaces[0]])).toBe(false);
    expect(shouldRenderWorkspaceSwitcher(workspaces)).toBe(true);
  });

  test('preserves management query parameters', () => {
    expect(workspaceManagementPath('account-1', 'new=1&clone=item-1')).toBe(
      '/accounts/account-1/workspaces?new=1&clone=item-1',
    );
  });

  test('redirects a legacy Project URL to the same canonical Workspace path and query', () => {
    expect(
      legacyWorkspaceDestination(
        ['workspace-1', 'sessions', 'session-1'],
        { view: 'files', tag: ['one', 'two'], empty: undefined },
      ),
    ).toBe('/workspaces/workspace-1/sessions/session-1?view=files&tag=one&tag=two');
  });
});
