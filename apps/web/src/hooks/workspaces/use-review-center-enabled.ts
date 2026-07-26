'use client';

import { getWorkspaceDetail } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

/**
 * The single on/off switch for the Review Center surface, read from the server's
 * per-workspace experimental flags (`review_center`). Every review-related surface —
 * the sidebar "Review" pill, the per-session row indicators, and the Customize
 * rail — gates off this one hook so they light up (and go dark) together. Reads
 * the shared `['workspace-detail', workspaceId]` cache entry, so it adds no extra
 * fetch alongside the detail query the sidebar already runs.
 */
export function useReviewCenterEnabled(workspaceId: string): boolean {
  const { data } = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    queryFn: () => getWorkspaceDetail(workspaceId),
    enabled: !!workspaceId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.workspace?.experimental?.review_center ?? false;
}
