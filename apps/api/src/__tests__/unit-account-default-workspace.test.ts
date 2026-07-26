import { expect, test } from 'bun:test';

import { AccountDetailSchema, AccountSummarySchema } from '../accounts/core/app';

test('account contracts expose the stored default workspace', () => {
  const summary = AccountSummarySchema.parse({
    account_id: 'account-1',
    name: 'Acme',
    slug: 'acme',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    default_workspace_id: 'workspace-1',
  });
  const detail = AccountDetailSchema.parse({
    account_id: 'account-1',
    name: 'Acme',
    member_count: 1,
    workspace_count: 1,
    role: 'owner',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    default_workspace_id: 'workspace-1',
  });

  expect(summary.default_workspace_id).toBe('workspace-1');
  expect(detail.default_workspace_id).toBe('workspace-1');
});
