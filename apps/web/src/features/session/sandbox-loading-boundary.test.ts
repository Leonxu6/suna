import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const boundarySource = readFileSync(join(import.meta.dir, 'sandbox-loading-boundary.tsx'), 'utf8');
const workspaceLayoutSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/workspaces/[id]/layout.tsx'),
  'utf8',
);
const workspaceAccessSource = readFileSync(
  join(import.meta.dir, '../../components/workspaces/workspace-access-boundary.tsx'),
  'utf8',
);
const workspaceHomeSource = readFileSync(
  join(import.meta.dir, '../workspace/workspace-layout/workspace-home.tsx'),
  'utf8',
);

describe('session navigation loading boundaries', () => {
  test('runtime-not-ready retries never render the full-page ASCII logo', () => {
    expect(boundarySource).toContain('return null;');
    expect(boundarySource).not.toContain('KortixHyperLogo');
    expect(boundarySource).not.toContain('min-h-[50vh]');
  });

  test('the workspace shell cannot be replaced by a route-wide sandbox fallback', () => {
    expect(workspaceLayoutSource).not.toContain('SandboxLoadingBoundary');
    expect(workspaceLayoutSource).toContain('<WorkspaceAccessBoundary workspaceId={workspaceId}>');
    expect(workspaceLayoutSource).toContain('<SessionCacheWarmer workspaceId={workspaceId} />');
    expect(workspaceLayoutSource).toContain('<WorkspaceShell workspaceId={workspaceId}>');
  });

  test('first workspace access still keeps its intentional full-page loader', () => {
    expect(workspaceAccessSource).toContain('function WorkspaceAccessLoading()');
    expect(workspaceAccessSource).toContain('<KortixHyperLogo');
    expect(workspaceAccessSource).toContain('min-h-screen');
  });

  test('the access boundary uses the lightweight workspace route', () => {
    expect(workspaceAccessSource).toContain('getWorkspace(workspaceId');
    expect(workspaceAccessSource).not.toContain('getWorkspaceDetail(workspaceId');
  });

  test('workspace home does not start the members query before Customize opens', () => {
    expect(workspaceAccessSource).toContain("queryKey: ['workspace-access-boundary', workspaceId]");
    expect(workspaceAccessSource).not.toContain("queryKey: ['workspace-access', workspaceId]");
    expect(workspaceHomeSource).not.toContain("queryKey: ['workspace-access', workspaceId]");
    expect(workspaceHomeSource).not.toContain('listWorkspaceAccess(workspaceId');
    expect(workspaceHomeSource).toContain('const WORKSPACE_SETUP_TILES');
  });
});
