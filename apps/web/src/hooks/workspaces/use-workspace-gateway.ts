'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type GatewayModelGenerationConfig,
  type GatewayPlaygroundResponse,
  type SetGatewayBudgetInput,
  createGatewayKey,
  deleteGatewayBudget,
  getGatewayBreakdown,
  getGatewayBudgets,
  getGatewayErrors,
  getGatewayKeys,
  getGatewayLog,
  getGatewayOverview,
  getGatewaySeries,
  getGatewaySessions,
  listGatewayLogs,
  revokeGatewayKey,
  runGatewayPlayground,
  setGatewayBudget,
} from '@/lib/workspaces-gateway-client';

export function useGatewayOverview(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['workspace-gateway-overview', workspaceId, days],
    queryFn: () => getGatewayOverview(workspaceId!, days),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useGatewaySeries(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['workspace-gateway-series', workspaceId, days],
    queryFn: () => getGatewaySeries(workspaceId!, days),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useGatewayBreakdown(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['workspace-gateway-breakdown', workspaceId, days],
    queryFn: () => getGatewayBreakdown(workspaceId!, days),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useGatewaySessions(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['workspace-gateway-sessions', workspaceId, days],
    queryFn: () => getGatewaySessions(workspaceId!, days),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useGatewayErrors(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['workspace-gateway-errors', workspaceId, days],
    queryFn: () => getGatewayErrors(workspaceId!, days),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useGatewayLogs(workspaceId: string | undefined, opts?: { ok?: boolean }) {
  return useQuery({
    queryKey: ['workspace-gateway-logs', workspaceId, opts?.ok ?? null],
    queryFn: () => listGatewayLogs(workspaceId!, { ok: opts?.ok, limit: 100 }),
    enabled: !!workspaceId,
    refetchInterval: 10_000,
  });
}

export function useGatewayLog(workspaceId: string | undefined, logId: string | null) {
  return useQuery({
    queryKey: ['workspace-gateway-log', workspaceId, logId],
    queryFn: () => getGatewayLog(workspaceId!, logId!),
    enabled: !!workspaceId && !!logId,
  });
}

export function useGatewayBudgets(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-gateway-budgets', workspaceId],
    queryFn: () => getGatewayBudgets(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 15_000,
  });
}

export function useSetGatewayBudget(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetGatewayBudgetInput) => setGatewayBudget(workspaceId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace-gateway-budgets', workspaceId] }),
  });
}

export function useDeleteGatewayBudget(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (budgetId: string) => deleteGatewayBudget(workspaceId!, budgetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace-gateway-budgets', workspaceId] }),
  });
}

export function useGatewayKeys(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['workspace-gateway-keys', workspaceId],
    queryFn: () => getGatewayKeys(workspaceId!),
    enabled: !!workspaceId && enabled,
    staleTime: 15_000,
  });
}

export function useCreateGatewayKey(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createGatewayKey(workspaceId!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace-gateway-keys', workspaceId] }),
  });
}

export function useRevokeGatewayKey(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => revokeGatewayKey(workspaceId!, keyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace-gateway-keys', workspaceId] }),
  });
}

export interface RunGatewayPlaygroundInput {
  prompt: string;
  models: string[];
  system?: string;
  /** Per-model generation-parameter overrides for this run only — see
   *  `runGatewayPlayground`'s doc comment. */
  generationConfig?: Record<string, GatewayModelGenerationConfig>;
}

/** Run one prompt across up to 6 models side by side — no cache, always a fresh run. */
export function useGatewayPlayground(workspaceId: string | undefined) {
  return useMutation<GatewayPlaygroundResponse, Error, RunGatewayPlaygroundInput>({
    mutationFn: ({ prompt, models, system, generationConfig }) =>
      runGatewayPlayground(workspaceId!, prompt, models, system, generationConfig),
  });
}
