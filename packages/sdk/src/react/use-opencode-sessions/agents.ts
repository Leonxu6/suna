'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap, getLSCache, setLSCache, LS_AGENTS, CACHE_SCOPE_GLOBAL } from './shared';
import { getWorkspaceDetail, type WorkspaceConfigSummary } from '../../core/rest/workspaces-client';

// Re-export filtered agents hook for UI agent selectors
export { useVisibleAgents } from '../use-visible-agents';

// ============================================================================
// Agent Hooks
// ============================================================================

/**
 * Load agents. With `workspaceId`, the server-side workspace config is source of
 * truth: it returns declarative `kortix.yaml` `agents:` entries for adopted
 * workspaces and OpenCode file discovery for legacy workspaces. Without `workspaceId`,
 * this falls back to the sandbox OpenCode runtime.
 */
export function useOpenCodeAgents(options?: { directory?: string; workspaceId?: string | null }) {
  const directory = options?.directory;
  const workspaceId = options?.workspaceId ?? null;
  const runtimeReady = useOpenCodeRuntimeReady();
  const cacheScope = workspaceId
    ? `workspace:${workspaceId}`
    : directory
      ? `dir:${directory}`
      : CACHE_SCOPE_GLOBAL;
  return useQuery<Agent[]>({
    queryKey: workspaceId
      ? ['workspace-detail', workspaceId, 'agents']
      : directory
        ? [...opencodeKeys.agents(), 'dir', directory]
        : opencodeKeys.agents(),
    queryFn: async () => {
      if (workspaceId) {
        const detail = await getWorkspaceDetail(workspaceId);
        const agents = workspaceConfigAgentsToOpenCodeAgents(detail.config);
        setLSCache(LS_AGENTS, agents, cacheScope);
        return agents;
      }
      const client = getClient();
      const result = await client.app.agents(directory ? { directory } : undefined);
      const data = unwrap(result);
      const agents: Agent[] = Array.isArray(data)
        ? data
        : Object.values(data as Record<string, Agent>);
      // Agents are defined in the workspace repo (.kortix/opencode/agents), so the
      // roster is stable across every session that shares a working directory.
      // Cache under a directory-scoped (or global) STABLE key — not the
      // ephemeral per-sandbox server id — so a new session's picker paints from
      // cache instead of waiting on sandbox boot + the in-box /app/agents call.
      // (Previously the directory case cached nothing at all → guaranteed pop-in.)
      setLSCache(LS_AGENTS, agents, cacheScope);
      return agents;
    },
    placeholderData: () => getLSCache<Agent[]>(LS_AGENTS, cacheScope),
    enabled: workspaceId ? true : runtimeReady,
    staleTime: workspaceId ? 30_000 : Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Put the declared workspace default first so every consumer's ordinary
 * "first visible agent" fallback agrees with the workspace contract. Explicit
 * per-session/user picks still resolve by name and therefore keep precedence.
 */
export function workspaceConfigAgentsToOpenCodeAgents(config: WorkspaceConfigSummary): Agent[] {
  const agents = config.agents.map(workspaceConfigAgentToOpenCodeAgent);
  const defaultName = config.default_agent ?? config.open_code_default_agent;
  if (!defaultName) return agents;
  return agents.sort((left, right) => {
    if (left.name === defaultName) return -1;
    if (right.name === defaultName) return 1;
    return 0;
  });
}

/** @deprecated Use `workspaceConfigAgentsToOpenCodeAgents`. */
export const projectConfigAgentsToOpenCodeAgents =
  workspaceConfigAgentsToOpenCodeAgents;

function workspaceConfigAgentToOpenCodeAgent(agent: WorkspaceConfigSummary['agents'][number]): Agent {
  return {
    name: agent.name,
    description: agent.description ?? undefined,
    mode: agent.mode ?? undefined,
    source: agent.source,
    hidden: agent.enabled === false,
  } as unknown as Agent;
}

export function useOpenCodeAgent(agentName: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Agent | undefined>({
    queryKey: [...opencodeKeys.agents(), agentName],
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.agents();
      const agents = unwrap(result);
      return agents.find((a: Agent) => a.name === agentName);
    },
    enabled: runtimeReady && !!agentName,
    staleTime: Infinity,
  });
}
