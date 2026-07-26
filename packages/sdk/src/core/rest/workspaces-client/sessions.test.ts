import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { isSessionFresh } from '../../http/fresh-sessions';
import {
  createWorkspaceSession,
  createSessionPublicShare,
  claimWarmWorkspaceSession,
  deleteWorkspaceSession,
  ensureWarmWorkspaceSession,
  getWorkspaceSession,
  getSessionAudit,
  getSessionPreviewCandidates,
  getSessionTranscript,
  listWorkspaceSessions,
  listSessionPublicShares,
  restartWorkspaceSession,
  revokeSessionPublicShare,
  setWorkspaceSessionSharing,
  stopWorkspaceSession,
  updateWorkspaceSession,
} from './sessions';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listWorkspaceSessions hits GET /workspaces/:id/sessions', async () => {
  nextResponse = { status: 200, body: [] };
  const result = await listWorkspaceSessions('P1');
  expect(last().url).toContain('/workspaces/P1/sessions');
  expect(last().method).toBe('GET');
  expect(result).toEqual([]);
});

test('listWorkspaceSessions requests the manager-only workspace inventory scope', async () => {
  nextResponse = { status: 200, body: [] };
  await listWorkspaceSessions('P1', { scope: 'workspace' });
  expect(last().url).toContain('/workspaces/P1/sessions?scope=workspace');
  expect(last().method).toBe('GET');
});

test('listWorkspaceSessions throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listWorkspaceSessions('P1')).rejects.toBeTruthy();
});

test('setWorkspaceSessionSharing PUTs the sharing intent', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1' } };
  await setWorkspaceSessionSharing('P1', 'S1', { mode: 'workspace' });
  expect(last().url).toContain('/workspaces/P1/sessions/S1/sharing');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ mode: 'workspace' });
});

test('getSessionPreviewCandidates hits the previews endpoint', async () => {
  nextResponse = { status: 200, body: { candidates: [] } };
  const result = await getSessionPreviewCandidates('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/previews');
  expect(result).toEqual({ candidates: [] });
});

test('listSessionPublicShares hits GET /public-shares with showErrors: false', async () => {
  nextResponse = { status: 200, body: { shares: [] } };
  const result = await listSessionPublicShares('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/public-shares');
  expect(result).toEqual({ shares: [] });
});

test('createSessionPublicShare POSTs the share input', async () => {
  nextResponse = { status: 200, body: { share: { share_id: 'SH1' } } };
  const input = { preview_id: 'prev-1', mode: 'view' as const };
  const result = await createSessionPublicShare('P1', 'S1', input);
  expect(last().url).toContain('/workspaces/P1/sessions/S1/public-shares');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(input);
  expect(result.share.share_id).toBe('SH1');
});

test('revokeSessionPublicShare DELETEs the specific share', async () => {
  nextResponse = { status: 200, body: { share: { share_id: 'SH1' } } };
  await revokeSessionPublicShare('P1', 'S1', 'SH1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/public-shares/SH1');
  expect(last().method).toBe('DELETE');
});

test('createWorkspaceSession POSTs the input and marks the new session fresh', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-1', name: null } };
  const result = await createWorkspaceSession('P1', { base_ref: 'main' });
  expect(last().url).toContain('/workspaces/P1/sessions');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ base_ref: 'main' });
  expect((result as any).session_id).toBe('NEW-1');
  expect(isSessionFresh('NEW-1')).toBe(true);
});

test('createWorkspaceSession serializes non-secret runtime_context unchanged', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-CONTEXT', name: null } };
  await createWorkspaceSession('P1', {
    runtime_context: {
      workspace_id: 'org_123',
      locale: 'fr',
      licensed: true,
      risk_score: 0.5,
      optional: null,
    },
  });
  expect(last().body).toEqual({
    runtime_context: {
      workspace_id: 'org_123',
      locale: 'fr',
      licensed: true,
      risk_score: 0.5,
      optional: null,
    },
  });
});

test('createWorkspaceSession does NOT mark the session fresh when an initial_prompt is set', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-2', name: null } };
  await createWorkspaceSession('P1', { initial_prompt: 'hello' });
  expect(isSessionFresh('NEW-2')).toBe(false);
});

test('createWorkspaceSession defaults the body to {} when no input is given', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-3' } };
  await createWorkspaceSession('P1');
  expect(last().body).toEqual({});
});

test('ensureWarmWorkspaceSession POSTs the server-owned warm-session request', async () => {
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-1' },
      reused: true,
      workspace_refresh: { status: 'unchanged' },
    },
  };
  const result = await ensureWarmWorkspaceSession('P1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/warm');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.session.session_id).toBe('WARM-1');
  expect(result.reused).toBe(true);
});

test('claimWarmWorkspaceSession POSTs the selected warm session and create options', async () => {
  nextResponse = { status: 200, body: { session_id: 'WARM-1' } };
  const result = await claimWarmWorkspaceSession('P1', {
    session_id: 'WARM-1',
    agent_name: 'reviewer',
    sandbox_slug: 'large',
  });
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/warm/claim');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    session_id: 'WARM-1',
    agent_name: 'reviewer',
    sandbox_slug: 'large',
  });
  expect(result.session_id).toBe('WARM-1');
});

test('getWorkspaceSession hits GET /workspaces/:id/sessions/:sid and forwards showErrors', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1' } };
  await getWorkspaceSession('P1', 'S1', { showErrors: false });
  expect(last().url).toContain('/workspaces/P1/sessions/S1');
  expect(last().method).toBe('GET');
});

test('getSessionAudit appends ?limit= only when a limit is given', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', agent: null, count: 0, actions: [] } };
  await getSessionAudit('P1', 'S1', 10);
  expect(last().url).toContain('/workspaces/P1/sessions/S1/audit?limit=10');

  await getSessionAudit('P1', 'S1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/audit');
});

test('getSessionTranscript builds the query string from limit/chars options', async () => {
  nextResponse = {
    status: 200,
    body: { available: true, reason: null, opencode_session_id: 'ocs-1', message_count: 0, messages: [] },
  };
  await getSessionTranscript('P1', 'S1', { limit: 5, chars: 200 });
  expect(last().url).toContain('/workspaces/P1/sessions/S1/transcript?limit=5&chars=200');

  await getSessionTranscript('P1', 'S1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/transcript');
});

test('updateWorkspaceSession PATCHes the name/metadata input', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', name: 'Renamed' } };
  await updateWorkspaceSession('P1', 'S1', { name: 'Renamed' });
  expect(last().url).toContain('/workspaces/P1/sessions/S1');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ name: 'Renamed' });
});

test('deleteWorkspaceSession DELETEs the session', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteWorkspaceSession('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1');
  expect(last().method).toBe('DELETE');
});

test('restartWorkspaceSession POSTs to /restart', async () => {
  nextResponse = { status: 200, body: { ok: true, session_id: 'S1', status: 'provisioning' } };
  const result = await restartWorkspaceSession('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/restart');
  expect(last().method).toBe('POST');
  expect(result.status).toBe('provisioning');
});

test('stopWorkspaceSession POSTs to /stop', async () => {
  nextResponse = { status: 200, body: { ok: true, session_id: 'S1', status: 'stopped' } };
  const result = await stopWorkspaceSession('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/stop');
  expect(last().method).toBe('POST');
  expect(result.status).toBe('stopped');
});
