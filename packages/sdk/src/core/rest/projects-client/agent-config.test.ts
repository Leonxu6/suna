import { describe, expect, test } from 'bun:test';

import type { AgentConfigBlock } from './index';

describe('AgentConfigBlock', () => {
  test('accepts an agent sandbox template slug', () => {
    const block: AgentConfigBlock = { sandbox: 'ml' };
    expect(block.sandbox).toBe('ml');
  });
});
