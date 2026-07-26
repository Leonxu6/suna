'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { SessionFilterValue } from '@/components/workspaces/session-label';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-workspace session-list filter (All / My Chats / Slack / Email / …).
 *
 * Held in a module-level, persisted store so the chosen filter survives the
 * workspace shell remounting on navigation — opening a session, ⌘J, switching
 * sessions. Local component state used to reset back to "all" on every such
 * remount.
 */

const STORAGE_KEY = 'kortix.workspace-session-filter';

/** Soft cap so the per-workspace map can't grow unbounded; keeps the last N. */
const MAX_TRACKED_WORKSPACES = 24;

function pruneWorkspaces<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_WORKSPACES) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_WORKSPACES).map((k) => [k, map[k]]));
}

interface State {
  filterByWorkspace: Record<string, SessionFilterValue>;
}

interface Actions {
  setFilter: (workspaceId: string, filter: SessionFilterValue) => void;
}

export const useSessionFilterStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      filterByWorkspace: {},
      setFilter: (workspaceId, filter) => {
        if ((get().filterByWorkspace[workspaceId] ?? 'all') === filter) return;
        set({ filterByWorkspace: { ...get().filterByWorkspace, [workspaceId]: filter } });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ filterByWorkspace: pruneWorkspaces(state.filterByWorkspace) }),
    },
  ),
);
