import { describe, expect, test } from 'bun:test';
import type { PermissionProbeInput } from './iam-client';
import { workspacePermissionProbes, workspacePermissionTarget } from './use-workspace-can';

// @ts-expect-error Workspace-scoped probes require resourceId.
const invalidWorkspaceProbe: PermissionProbeInput = {
  action: 'workspace.read',
  resourceType: 'workspace',
};
void invalidWorkspaceProbe;

describe('workspacePermissionTarget', () => {
  test('omits the workspace scope until the workspace id exists', () => {
    expect(workspacePermissionTarget(undefined)).toBeUndefined();
  });

  test('returns a complete workspace scope', () => {
    expect(workspacePermissionTarget('workspace-1')).toEqual({
      resourceType: 'workspace',
      resourceId: 'workspace-1',
    });
  });
});

describe('workspacePermissionProbes', () => {
  test('sends no probes while the workspace id is absent', () => {
    expect(workspacePermissionProbes(undefined, ['workspace.read'])).toEqual([]);
  });

  test('adds the workspace id to every scoped probe', () => {
    expect(workspacePermissionProbes('workspace-1', ['workspace.read', 'workspace.write'])).toEqual([
      { action: 'workspace.read', resourceType: 'workspace', resourceId: 'workspace-1' },
      { action: 'workspace.write', resourceType: 'workspace', resourceId: 'workspace-1' },
    ]);
  });
});
