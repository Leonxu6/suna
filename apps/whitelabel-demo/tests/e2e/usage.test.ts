/**
 * `/api/usage` — aggregates `GET /workspaces/:id/gateway/sessions` across every
 * workspace the caller owns, applies `COST_MARKUP`, and degrades gracefully if
 * one workspace's upstream call fails.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { COST_MARKUP, DEMO_PASSWORD, wrapperEnv, WRAPPER_KEY } from './env';

async function provision(app: AppInstance, token: string, name: string): Promise<string> {
  const workspace = await createTestKortix(app, token).workspaces.provision({ name });
  return workspace.workspace_id;
}

describe('/api/usage', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  test('markup math is exact for a single workspace', async () => {
    const email = uniqueEmail('usage-single');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const workspaceId = await provision(app, token, 'Usage Single');
    mock.seedGatewaySessions(workspaceId, [
      { session_id: 's1', total_cost: 10 },
      { session_id: 's2', total_cost: 2.5 },
    ]);

    const res = await fetch(`${app.baseUrl}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      markup: number;
      totals: { raw: number; billed: number };
      workspaces: Array<{ workspaceId: string; sessions: Array<{ billed_cost: number; total_cost: number }> }>;
    };

    expect(data.markup).toBe(Number(COST_MARKUP));
    expect(data.totals.raw).toBe(12.5);
    expect(data.totals.billed).toBe(Math.round(12.5 * Number(COST_MARKUP) * 100) / 100);

    const proj = data.workspaces.find((p) => p.workspaceId === workspaceId)!;
    expect(proj.sessions.find((s) => s.total_cost === 10)!.billed_cost).toBe(15);
    expect(proj.sessions.find((s) => s.total_cost === 2.5)!.billed_cost).toBe(3.75);
  });

  test('sums across multiple owned workspaces', async () => {
    const email = uniqueEmail('usage-multi');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const p1 = await provision(app, token, 'Usage Multi 1');
    const p2 = await provision(app, token, 'Usage Multi 2');
    mock.seedGatewaySessions(p1, [{ session_id: 'a', total_cost: 4 }]);
    mock.seedGatewaySessions(p2, [{ session_id: 'b', total_cost: 6 }]);

    const res = await fetch(`${app.baseUrl}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { totals: { raw: number; billed: number }; workspaces: unknown[] };
    expect(data.workspaces).toHaveLength(2);
    expect(data.totals.raw).toBe(10);
    expect(data.totals.billed).toBe(15); // 10 * 1.5
  });

  test('degrades gracefully when one owned workspace errors upstream', async () => {
    const email = uniqueEmail('usage-degrade');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const healthy = await provision(app, token, 'Usage Healthy');
    const broken = await provision(app, token, 'Usage Broken');
    mock.seedGatewaySessions(healthy, [{ session_id: 'ok', total_cost: 8 }]);
    mock.failGatewayFor(broken);

    const res = await fetch(`${app.baseUrl}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totals: { raw: number; billed: number };
      workspaces: Array<{ workspaceId: string; sessions: unknown[]; error?: string }>;
    };

    const healthyEntry = data.workspaces.find((p) => p.workspaceId === healthy)!;
    const brokenEntry = data.workspaces.find((p) => p.workspaceId === broken)!;
    expect(healthyEntry.sessions).toHaveLength(1);
    expect(brokenEntry.sessions).toHaveLength(0);
    expect(brokenEntry.error).toBeTruthy();
    // Totals reflect only the healthy workspace — one bad upstream doesn't 500 the whole response.
    expect(data.totals.raw).toBe(8);
    expect(data.totals.billed).toBe(12);
  });
});
