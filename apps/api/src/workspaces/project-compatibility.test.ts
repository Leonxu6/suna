import { describe, expect, test } from 'bun:test';
import {
  toCanonicalWorkspacePath,
  toDeprecatedProjectResponse,
} from './project-compatibility';

describe('deprecated project response compatibility', () => {
  test('maps canonical workspace identifiers and values recursively', () => {
    expect(
      toDeprecatedProjectResponse({
        workspace_id: 'ws-1',
        workspace_role: 'editor',
        nested: [{ effective_workspace_role: 'viewer', visibility: 'workspace' }],
        managed_by: 'workspace_secret',
      }),
    ).toEqual({
      project_id: 'ws-1',
      project_role: 'editor',
      nested: [{ effective_project_role: 'viewer', visibility: 'project' }],
      managed_by: 'project_secret',
    });
  });

  test('maps deprecated executor project routes to canonical workspace routes', () => {
    expect(
      toCanonicalWorkspacePath('/v1/executor/projects/ws-1/connectors'),
    ).toBe('/v1/executor/workspaces/ws-1/connectors');
    expect(toCanonicalWorkspacePath('/v1/projects/ws-1')).toBe(
      '/v1/projects/ws-1',
    );
  });
});
