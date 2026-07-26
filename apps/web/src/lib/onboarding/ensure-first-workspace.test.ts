import { describe, expect, test } from 'bun:test';

import {
  hasFirstWorkspaceBootstrapSignal,
  shouldAutoCreateFirstWorkspace,
} from './ensure-first-workspace';

describe('hasFirstWorkspaceBootstrapSignal', () => {
  test('recognizes explicit signup and subscription-return bootstrap signals', () => {
    expect(hasFirstWorkspaceBootstrapSignal(new URLSearchParams('auth_event=signup'))).toBe(true);
    expect(hasFirstWorkspaceBootstrapSignal(new URLSearchParams('team_signup=success'))).toBe(true);
  });

  test('ignores ordinary workspaces visits and non-signup auth events', () => {
    expect(hasFirstWorkspaceBootstrapSignal(new URLSearchParams())).toBe(false);
    expect(hasFirstWorkspaceBootstrapSignal(new URLSearchParams('auth_event=login'))).toBe(false);
  });
});

describe('shouldAutoCreateFirstWorkspace', () => {
  test('allows the post-subscription onboarding return to bootstrap the first workspace', () => {
    expect(
      shouldAutoCreateFirstWorkspace({
        bootstrapRequested: true,
        activeAccountId: 'acct_123',
        canCreateWorkspaces: true,
        autoCreateAttempted: false,
        accountsLoading: false,
        workspacesLoading: false,
        workspacesError: false,
        workspacesLoaded: true,
        workspaceCount: 0,
        legacyMachinesLoaded: true,
        legacyMachineCount: 0,
        billingEnabled: true,
        accountStateLoading: false,
        canRun: true,
      }),
    ).toBe(true);
  });

  test('does not recreate a workspace when a normal workspaces visit becomes empty after deletion', () => {
    expect(
      shouldAutoCreateFirstWorkspace({
        bootstrapRequested: false,
        activeAccountId: 'acct_123',
        canCreateWorkspaces: true,
        autoCreateAttempted: false,
        accountsLoading: false,
        workspacesLoading: false,
        workspacesError: false,
        workspacesLoaded: true,
        workspaceCount: 0,
        legacyMachinesLoaded: true,
        legacyMachineCount: 0,
        billingEnabled: true,
        accountStateLoading: false,
        canRun: true,
      }),
    ).toBe(false);
  });
});
