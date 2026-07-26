import { describe, expect, test } from 'bun:test';
import { buildVoiceMcpEndpoint } from './kortix-client';

describe('buildVoiceMcpEndpoint', () => {
  test('uses the canonical Workspace route', () => {
    expect(
      buildVoiceMcpEndpoint({
        workspaceId: 'workspace/1',
        sessionId: 'session/1',
        callId: 'call-1',
        kortixApiUrl: 'https://api.kortix.com/',
        kortixApiToken: 'token-1',
        botName: 'Kortix',
      }),
    ).toBe(
      'https://api.kortix.com/v1/workspaces/workspace%2F1/sessions/session%2F1/mcp/voice',
    );
  });
});
