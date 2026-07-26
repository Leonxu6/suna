'use client';

/**
 * useWorkspaceOnboarding — server-side per-workspace guided-onboarding status.
 *
 * Tracks whether the workspace's guided onboarding wizard has been completed
 * (or explicitly skipped). Persisted server-side in `workspaces.metadata.
 * onboarding_completed_at` (a single ISO timestamp; presence = completed)
 * via PATCH /v1/workspaces/:workspaceId/onboarding. No schema migration needed —
 * the metadata jsonb already exists and serializeWorkspace already exposes it.
 *
 *   status === 'pending'   → first-time, wizard auto-opens
 *   status === 'completed' → user finished or skipped, wizard stays closed
 *
 * Reads ride on the same `workspace-detail` query the rest of the workspace uses
 * so there's no extra round-trip — completion just reflects whatever the
 * already-cached metadata says. `complete()` mutates the server AND
 * optimistically updates the cache so the wizard fades out instantly.
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getWorkspaceDetail,
  setWorkspaceOnboardingComplete,
} from '@kortix/sdk';

export type WorkspaceOnboardingStatus = 'pending' | 'completed';

/** Shape of the cached `workspace-detail` query data. */
type WorkspaceDetailData = Awaited<ReturnType<typeof getWorkspaceDetail>>;

interface WorkspaceMetadataMaybe {
  onboarding_completed_at?: string | null;
  [key: string]: unknown;
}

export interface WorkspaceOnboardingState {
  status: WorkspaceOnboardingStatus;
  /** False until the workspace-detail query has resolved at least once. */
  hydrated: boolean;
  /** Mark complete (server) + optimistically update local cache. */
  complete: () => Promise<unknown>;
  /** Re-open onboarding by clearing the server flag. Mostly for QA/devtools. */
  reset: () => Promise<unknown>;
}

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function useWorkspaceOnboarding(workspaceId: string): WorkspaceOnboardingState {
  const enabled = !!workspaceId;
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    queryFn: () => getWorkspaceDetail(workspaceId),
    enabled,
    ...Q,
  });

  const status: WorkspaceOnboardingStatus = useMemo(() => {
    const meta = (detail.data?.workspace?.metadata ?? {}) as WorkspaceMetadataMaybe;
    return meta.onboarding_completed_at ? 'completed' : 'pending';
  }, [detail.data]);

  // Optimistic cache update mirrors what the server will return, so the
  // wizard fades out immediately and we don't refetch before the UI reacts.
  const applyOptimistic = useCallback(
    (completed: boolean) => {
      const key = ['workspace-detail', workspaceId] as const;
      queryClient.setQueryData(key, (prev: WorkspaceDetailData | undefined) => {
        if (!prev?.workspace) return prev;
        const meta = { ...(prev.workspace.metadata ?? {}) } as WorkspaceMetadataMaybe;
        if (completed) {
          meta.onboarding_completed_at = new Date().toISOString();
        } else {
          delete meta.onboarding_completed_at;
        }
        return {
          ...prev,
          workspace: { ...prev.workspace, metadata: meta },
        };
      });
    },
    [workspaceId, queryClient],
  );

  // Snapshot the cache before the optimistic write so onError restores the
  // exact prior value — applying the *opposite* optimistic update would clobber
  // a pre-existing onboarding_completed_at (e.g. an already-completed workspace).
  const snapshotThenApply = useCallback(
    async (completed: boolean) => {
      const key = ['workspace-detail', workspaceId] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkspaceDetailData>(key);
      applyOptimistic(completed);
      return { previous };
    },
    [workspaceId, queryClient, applyOptimistic],
  );

  const restorePrevious = useCallback(
    (context: { previous: WorkspaceDetailData | undefined } | undefined) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(['workspace-detail', workspaceId], context.previous);
      }
    },
    [workspaceId, queryClient],
  );

  const completeMutation = useMutation({
    mutationFn: () => setWorkspaceOnboardingComplete(workspaceId, true),
    onMutate: () => snapshotThenApply(true),
    onError: (_err, _vars, context) => restorePrevious(context),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => setWorkspaceOnboardingComplete(workspaceId, false),
    onMutate: () => snapshotThenApply(false),
    onError: (_err, _vars, context) => restorePrevious(context),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
    },
  });

  return {
    status,
    hydrated: enabled && !detail.isLoading,
    complete: () => completeMutation.mutateAsync(),
    reset: () => resetMutation.mutateAsync(),
  };
}
