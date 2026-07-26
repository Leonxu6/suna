'use client';

import { useMemo } from 'react';
import type { ServerHealth, RuntimeWorkspaceInfo } from '@/features/file-browser/types';

/**
 * In the workspace-files view, "the server" is always the backend API — there
 * is no per-sandbox OpenCode instance to health-check. Treat as healthy.
 */
export function useServerHealth(_options?: { enabled?: boolean }) {
  return useMemo(
    () => ({
      data: { healthy: true, version: 'workspace-files' } as ServerHealth,
      isLoading: false,
      isError: false,
      error: null as Error | null,
      refetch: async () => ({ data: { healthy: true, version: 'workspace-files' } } as any),
    }),
    [],
  );
}

/**
 * Workspace view exposes a synthetic "current workspace" stub so the existing
 * git-status gate (`workspace?.vcs === 'git'`) continues to behave correctly.
 */
export function useCurrentWorkspace(_options?: { enabled?: boolean }) {
  const data: RuntimeWorkspaceInfo = {
    id: 'workspace-files',
    worktree: '/workspace',
    vcs: 'git',
    name: 'workspace',
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  };
  return useMemo(
    () => ({
      data,
      isLoading: false,
      isError: false,
      error: null as Error | null,
      refetch: async () => ({ data } as any),
    }),
    [],
  );
}
