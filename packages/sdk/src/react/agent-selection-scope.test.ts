import { describe, expect, test } from 'bun:test';

import { createAgentSelectionScope } from './agent-selection-scope';

describe('createAgentSelectionScope', () => {
  test('stays stable while an asynchronous workspace default hydrates', () => {
    const beforeWorkspaceDefault = createAgentSelectionScope({
      workspaceId: 'workspace-1',
    });
    const afterWorkspaceDefault = createAgentSelectionScope({
      workspaceId: 'workspace-1',
    });

    expect(afterWorkspaceDefault).toBe(beforeWorkspaceDefault);
  });

  test('resets an explicit composer selection when the route workspace changes', () => {
    expect(createAgentSelectionScope({ workspaceId: 'workspace-1' })).not.toBe(
      createAgentSelectionScope({ workspaceId: 'workspace-2' }),
    );
  });

  test('keeps session and server-bound agent identity in the scope', () => {
    expect(
      createAgentSelectionScope({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        boundAgentName: 'kortix',
      }),
    ).not.toBe(
      createAgentSelectionScope({
        workspaceId: 'workspace-1',
        sessionId: 'session-2',
        boundAgentName: 'kortix',
      }),
    );
  });
});
