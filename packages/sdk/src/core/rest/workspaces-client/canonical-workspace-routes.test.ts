import { expect, test } from 'bun:test';

const CANONICAL_ROUTE_CONSUMERS = [
  new URL('../../../react/use-teams-installations.ts', import.meta.url),
  new URL('../platform-client/host-boundary.ts', import.meta.url),
  new URL('../../../react/use-admin-accounts.ts', import.meta.url),
];

test('Workspace SDK consumers do not call deprecated Project routes', async () => {
  for (const file of CANONICAL_ROUTE_CONSUMERS) {
    const source = await Bun.file(file).text();
    expect(source).not.toMatch(/[`'"]\/(?:v1\/)?projects(?:\/|[`'"])/);
  }
});

test('operations overview exposes the canonical Workspace total', async () => {
  const source = await Bun.file(
    new URL('../../../react/use-ops-overview.ts', import.meta.url),
  ).text();
  expect(source).toContain('workspaces: number');
  expect(source).not.toContain('projects: number');
});
