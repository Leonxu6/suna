import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  claimWarmProjectSession,
  ensureWarmProjectSession,
  type ClaimWarmProjectSessionInput,
  type WarmProjectSessionResult,
} from './index';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    const requestUrl = String(url);
    calls.push({
      url: requestUrl,
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    const body = requestUrl.endsWith('/claim')
      ? { session_id: 'session-1' }
      : {
          session: { session_id: 'session-1' },
          reused: true,
          workspace_refresh: { status: 'unchanged' },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'token',
  });
});

test('deprecated warm Project aliases delegate to canonical Workspace routes', async () => {
  const ensured: WarmProjectSessionResult = await ensureWarmProjectSession('workspace-1');
  const input: ClaimWarmProjectSessionInput = { session_id: ensured.session.session_id };
  await claimWarmProjectSession('workspace-1', input);

  expect(calls).toEqual([
    {
      url: 'http://backend.test/v1/workspaces/workspace-1/sessions/warm',
      method: 'POST',
      body: {},
    },
    {
      url: 'http://backend.test/v1/workspaces/workspace-1/sessions/warm/claim',
      method: 'POST',
      body: input,
    },
  ]);
});
