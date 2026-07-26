import { beforeEach, expect, mock, test } from 'bun:test';

import { resolveFirstWorkspacePathForNewUser } from './bootstrap-first-workspace';

let responses: Response[] = [];

beforeEach(() => {
  responses = [];
  globalThis.fetch = mock(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more mocked responses queued');
    return next;
  }) as unknown as typeof fetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OPTS = { backendUrl: 'http://backend.test/v1', accessToken: 'tok', isNewUser: true };

test('returns null (safe /workspaces fallback) when provision reports ok but the body has no workspace_id', async () => {
  responses = [
    jsonResponse([{ account_id: 'acc-1' }]), // GET /accounts
    jsonResponse([]), // GET /workspaces?account_id= — none yet
    jsonResponse({ name: 'My First Workspace' }, 200), // POST /workspaces/provision — 200 but NO workspace_id
  ];

  const path = await resolveFirstWorkspacePathForNewUser(OPTS);
  expect(path).toBeNull();
});

test('builds /workspaces/{id} when provision succeeds with a real workspace_id', async () => {
  responses = [
    jsonResponse([{ account_id: 'acc-1' }]),
    jsonResponse([]),
    jsonResponse({ workspace_id: 'proj-123' }, 200),
  ];

  const path = await resolveFirstWorkspacePathForNewUser(OPTS);
  expect(path).toBe('/workspaces/proj-123');
});

test('returns null for an existing user (not a new signup)', async () => {
  const path = await resolveFirstWorkspacePathForNewUser({ ...OPTS, isNewUser: false });
  expect(path).toBeNull();
});
