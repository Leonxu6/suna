'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import {
  clearModelDefault,
  getModelDefaults,
  type ModelDefaultsResponse,
  setModelDefault,
} from '../core/rest/workspaces-client/model-defaults';
import {
  type ModelKey,
  modelKeyToWire,
  seedGlobalDefaultFromServer,
  setGlobalDefaultModel,
  wireToModelKey,
} from './use-model-store';

export interface UseModelDefaults {
  data: ModelDefaultsResponse | undefined;
  isLoading: boolean;
  isUpdating: boolean;
  accountDefault: ModelKey | undefined;
  agentDefaults: Record<string, ModelKey>;
  workspaceDefault: ModelKey | undefined;
  platformDefault: ModelKey | undefined;
  freeTier: boolean;
  resolveDefaultFor: (agentName: string | undefined) => ModelKey | undefined;
  setAccountDefault: (model: ModelKey) => Promise<void>;
  setAgentDefault: (agentName: string, model: ModelKey) => Promise<void>;
  setWorkspaceDefault: (model: ModelKey) => Promise<void>;
  clearAccountDefault: () => Promise<void>;
  clearAgentDefault: (agentName: string) => Promise<void>;
  clearWorkspaceDefault: () => Promise<void>;
}

export function resolveModelDefault(
  data: ModelDefaultsResponse | undefined,
  agentName: string | undefined,
): ModelKey | undefined {
  const wire =
    (agentName ? data?.agentDefaults?.[agentName] : undefined) ??
    data?.workspaceDefault ??
    data?.accountDefault ??
    (data?.freeTier ? undefined : data?.platformDefault);
  return wire ? wireToModelKey(wire) : undefined;
}

export function useModelDefaults(
  workspaceId: string | null | undefined,
): UseModelDefaults {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['model-defaults', workspaceId], [workspaceId]);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getModelDefaults(workspaceId as string),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!data) return;
    seedGlobalDefaultFromServer(
      data.accountDefault ? wireToModelKey(data.accountDefault) : undefined,
    );
  }, [data?.accountDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ['gateway-routing-policy', workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ['workspace-model-picker', workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ['workspace-providers', workspaceId] }),
    ]);
  }, [workspaceId, queryClient, queryKey]);

  const setMutation = useMutation({
    mutationFn: (input: {
      scope: 'account' | 'agent' | 'workspace';
      agentName?: string;
      model: string;
    }) => setModelDefault(workspaceId as string, input),
    onSuccess: invalidate,
  });
  const clearMutation = useMutation({
    mutationFn: (params: {
      scope: 'account' | 'agent' | 'workspace';
      agentName?: string;
    }) => clearModelDefault(workspaceId as string, params),
    onSuccess: invalidate,
  });

  const accountDefault = useMemo(
    () => (data?.accountDefault ? wireToModelKey(data.accountDefault) : undefined),
    [data?.accountDefault],
  );
  const agentDefaults = useMemo<Record<string, ModelKey>>(() => {
    const defaults: Record<string, ModelKey> = {};
    for (const [name, wire] of Object.entries(data?.agentDefaults ?? {})) {
      defaults[name] = wireToModelKey(wire);
    }
    return defaults;
  }, [data?.agentDefaults]);
  const workspaceDefault = useMemo(
    () => (data?.workspaceDefault ? wireToModelKey(data.workspaceDefault) : undefined),
    [data?.workspaceDefault],
  );
  const platformDefault = useMemo(
    () => (data?.platformDefault ? wireToModelKey(data.platformDefault) : undefined),
    [data?.platformDefault],
  );
  const resolveDefaultFor = useCallback(
    (agentName: string | undefined) => resolveModelDefault(data, agentName),
    [data],
  );

  const setAccountDefault = useCallback(
    async (model: ModelKey) => {
      setGlobalDefaultModel(model);
      await setMutation.mutateAsync({
        scope: 'account',
        model: modelKeyToWire(model),
      });
    },
    [setMutation],
  );
  const setAgentDefault = useCallback(
    async (agentName: string, model: ModelKey) => {
      await setMutation.mutateAsync({
        scope: 'agent',
        agentName,
        model: modelKeyToWire(model),
      });
    },
    [setMutation],
  );
  const setWorkspaceDefault = useCallback(
    async (model: ModelKey) => {
      await setMutation.mutateAsync({
        scope: 'workspace',
        model: modelKeyToWire(model),
      });
    },
    [setMutation],
  );
  const clearAccountDefault = useCallback(async () => {
    setGlobalDefaultModel(undefined);
    await clearMutation.mutateAsync({ scope: 'account' });
  }, [clearMutation]);
  const clearAgentDefault = useCallback(
    async (agentName: string) => {
      await clearMutation.mutateAsync({ scope: 'agent', agentName });
    },
    [clearMutation],
  );
  const clearWorkspaceDefault = useCallback(async () => {
    await clearMutation.mutateAsync({ scope: 'workspace' });
  }, [clearMutation]);

  return {
    data,
    isLoading,
    isUpdating: setMutation.isPending || clearMutation.isPending,
    accountDefault,
    agentDefaults,
    workspaceDefault,
    platformDefault,
    // Fail closed while the account policy loads. This prevents a free account
    // from seeing managed models for one render before the server response.
    freeTier: data ? data.freeTier : true,
    resolveDefaultFor,
    setAccountDefault,
    setAgentDefault,
    setWorkspaceDefault,
    clearAccountDefault,
    clearAgentDefault,
    clearWorkspaceDefault,
  };
}
