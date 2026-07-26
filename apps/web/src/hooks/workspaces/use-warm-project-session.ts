'use client';

import { ensureWarmWorkspaceSession } from '@kortix/sdk';
import { prefetchSessionStart } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

export const warmWorkspaceSessionKey = (workspaceId: string) =>
  ['workspace-warm-session', workspaceId] as const;

export function useWarmWorkspaceSession(workspaceId: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: warmWorkspaceSessionKey(workspaceId ?? ''),
    queryFn: () => ensureWarmWorkspaceSession(workspaceId!),
    enabled: !!workspaceId,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const sessionId = query.data?.session.session_id;
  useEffect(() => {
    if (!workspaceId || !sessionId) return;
    prefetchSessionStart(queryClient, workspaceId, sessionId);
  }, [workspaceId, queryClient, sessionId]);

  const resolveSession = useCallback(async () => {
    if (!workspaceId) return undefined;
    const result = await queryClient.fetchQuery({
      queryKey: warmWorkspaceSessionKey(workspaceId),
      queryFn: () => ensureWarmWorkspaceSession(workspaceId),
      staleTime: 10_000,
      retry: false,
    });
    return result.session;
  }, [workspaceId, queryClient]);

  return { ...query, resolveSession };
}
