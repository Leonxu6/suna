import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionFilterStore } from './session-filter-store';

beforeEach(() => {
  useSessionFilterStore.setState({ filterByWorkspace: {} });
});

describe('useSessionFilterStore', () => {
  test('defaults to "all" for an unseen workspace', () => {
    expect(useSessionFilterStore.getState().filterByWorkspace.p1 ?? 'all').toBe('all');
  });

  test('persists the chosen filter per workspace so it survives a remount', () => {
    useSessionFilterStore.getState().setFilter('p1', 'email');
    expect(useSessionFilterStore.getState().filterByWorkspace.p1).toBe('email');
  });

  test('keeps each workspace filter independent', () => {
    useSessionFilterStore.getState().setFilter('p1', 'email');
    useSessionFilterStore.getState().setFilter('p2', 'slack');
    expect(useSessionFilterStore.getState().filterByWorkspace.p1).toBe('email');
    expect(useSessionFilterStore.getState().filterByWorkspace.p2).toBe('slack');
  });

  test('re-selecting the same filter is a no-op (no new object)', () => {
    useSessionFilterStore.getState().setFilter('p1', 'slack');
    const before = useSessionFilterStore.getState().filterByWorkspace;
    useSessionFilterStore.getState().setFilter('p1', 'slack');
    expect(useSessionFilterStore.getState().filterByWorkspace).toBe(before);
  });
});
