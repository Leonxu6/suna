import { describe, expect, test } from 'bun:test';
import { resolveCallContext } from './call-context';

const REQUIRED_ROOM_METADATA = {
  session_id: 'session-1',
};
const WORKER_METADATA = JSON.stringify({ kortix_api_token: 'token-1' });

describe('resolveCallContext', () => {
  test('uses canonical workspace_id metadata', () => {
    const context = resolveCallContext(
      'room-1',
      JSON.stringify({ ...REQUIRED_ROOM_METADATA, workspace_id: 'workspace-1' }),
      WORKER_METADATA,
    );

    expect(context.workspaceId).toBe('workspace-1');
  });

  test('prefers workspace_id over deprecated project_id', () => {
    const context = resolveCallContext(
      'room-1',
      JSON.stringify({
        ...REQUIRED_ROOM_METADATA,
        workspace_id: 'workspace-1',
        project_id: 'project-1',
      }),
      WORKER_METADATA,
    );

    expect(context.workspaceId).toBe('workspace-1');
  });

  test('accepts deprecated project_id metadata', () => {
    const context = resolveCallContext(
      'room-1',
      JSON.stringify({ ...REQUIRED_ROOM_METADATA, project_id: 'project-1' }),
      WORKER_METADATA,
    );

    expect(context.workspaceId).toBe('project-1');
  });

  test('rejects metadata without a workspace identifier', () => {
    expect(() =>
      resolveCallContext('room-1', JSON.stringify(REQUIRED_ROOM_METADATA), WORKER_METADATA),
    ).toThrow('voice-agent: room metadata is missing workspace_id');
  });
});
