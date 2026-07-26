import { describe, expect, test } from 'bun:test';
import { buildVoiceEndpoint } from './kortix-client';

describe('buildVoiceEndpoint', () => {
  test('uses the canonical Workspace route', () => {
    expect(
      buildVoiceEndpoint(
        {
          workspaceId: 'workspace/1',
          sessionId: 'session/1',
          callId: 'call-1',
          kortixApiUrl: 'https://api.kortix.com/',
          kortixApiToken: 'token-1',
          botName: 'Kortix',
        },
        'prompt',
      ),
    ).toBe(
      'https://api.kortix.com/v1/workspaces/workspace%2F1/sessions/session%2F1/voice/prompt',
    );
  });
});
