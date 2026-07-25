'use client';

import { useQuery } from '@tanstack/react-query';
import { type WorkspaceConfigSummary, getWorkspaceDetail } from '../core/rest/workspaces-client';

/**
 * Server-side workspace config — the single source of truth for everything a user
 * selects AROUND a session: agents, commands, skills, the default agent, and env
 * requirements. Fetched from the Kortix server (workspace detail), so it works
 * before any sandbox runtime exists. This is the canonical home for the
 * "capabilities, not runtime state" split — `useVisibleAgents({ workspaceId })`
 * and `useWorkspaceModels(workspaceId)` are the per-surface siblings.
 */
export function useWorkspaceConfig(
  workspaceId: string | null | undefined,
): WorkspaceConfigSummary | undefined {
  const { data } = useQuery({
    queryKey: ['workspace-config', workspaceId],
    queryFn: async () => (await getWorkspaceDetail(workspaceId as string)).config,
    enabled: !!workspaceId,
    staleTime: 30_000,
    retry: false,
  });
  return data;
}
