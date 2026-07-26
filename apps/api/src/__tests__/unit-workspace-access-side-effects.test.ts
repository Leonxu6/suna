import { describe, expect, it } from 'bun:test';

const accessSource = await Bun.file(
  new URL('../workspaces/lib/access.ts', import.meta.url),
).text();

describe('workspace authorization side effects', () => {
  it('does not resume a sandbox during generic workspace authorization', () => {
    expect(accessSource).not.toContain('preResumeRecentStoppedSessions');
    expect(accessSource).not.toContain('KORTIX_PRERESUME');
  });
});
