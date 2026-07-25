'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { useKortixRouteWorkspaceId } from '../route-workspace';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import type { ProviderListResponse } from './keys';
import { unwrap, getLSCache, setLSCache, LS_PROVIDERS, CACHE_SCOPE_GLOBAL } from './shared';
import {
  getWorkspaceDetail,
  getWorkspaceModelPicker,
  listWorkspaceSecrets,
} from '../../core/rest/workspaces-client';
import {
  filterToGatewayProviders,
  filterToNativeProviders,
  GATEWAY_PROVIDER_IDS,
  LLM_PROVIDER_CREDENTIALS,
  mergeWorkspaceSecretConnectedProviders,
  normalizeProviderList,
  workspaceLlmCatalogToProviderList,
  providerListHasModels,
} from '../provider-selection';

// ============================================================================
// Provider Hooks
// ============================================================================

export { GATEWAY_PROVIDER_IDS };

export function useOpenCodeProviders() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const workspaceId = useKortixRouteWorkspaceId();
  const workspaceDetailQuery = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    queryFn: () => getWorkspaceDetail(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
  const workspaceGatewayEnabled =
    workspaceId ? workspaceDetailQuery.data?.workspace.experimental?.llm_gateway === true : false;
  const workspaceModeKnown = !workspaceId || workspaceDetailQuery.isSuccess;
  // BYOK makes the connected model set workspace-specific (a provider connected
  // in one workspace must NOT leak into another, nor linger after removal), so
  // the persisted placeholder is scoped per workspace — not the old global scope.
  const cacheScope = workspaceId
    ? `proj:${workspaceId}:${workspaceGatewayEnabled ? 'gateway' : 'native'}`
    : CACHE_SCOPE_GLOBAL;
  return useQuery<ProviderListResponse>({
    queryKey: workspaceId
      ? ['workspace-providers', workspaceId, workspaceGatewayEnabled ? 'gateway' : 'native']
      : opencodeKeys.providers(),
    queryFn: async () => {
      if (workspaceId && workspaceGatewayEnabled) {
        const catalog = await getWorkspaceModelPicker(workspaceId);
        const providers = workspaceLlmCatalogToProviderList(catalog);
        setLSCache(LS_PROVIDERS, providers, cacheScope);
        return providers;
      }
      const client = getClient();
      const result = await client.provider.list();
      let rawProviders = normalizeProviderList(unwrap(result));
      if (workspaceId) {
        const secrets = await listWorkspaceSecrets(workspaceId);
        const items = Array.isArray(secrets) ? secrets : (secrets.items ?? []);
        const secretNames = new Set(items.map((secret: { name: string }) => secret.name));
        rawProviders = mergeWorkspaceSecretConnectedProviders(
          rawProviders,
          secretNames,
          LLM_PROVIDER_CREDENTIALS,
        );
      }
      const providers = workspaceId ? filterToNativeProviders(rawProviders) : rawProviders;

      // During sandbox boot the OpenCode server frequently answers
      // /provider/list BEFORE its provider config is wired up, returning zero
      // CONNECTED providers (→ zero models). With staleTime:Infinity such an
      // empty answer would be cached for the whole session and never refetched,
      // AND persisted to the global localStorage cache below — poisoning the
      // first frame of every future session too. That is the "model picker
      // never shows up" bug. Treat a model-less response as a transient boot
      // state: throw so React Query retries it (with backoff), and never cache
      // or persist it.
      if (!providerListHasModels(providers)) {
        throw new Error(
          'opencode provider list has no connected models yet — sandbox still warming up',
        );
      }

      // Persist under the per-workspace scope (never the ephemeral per-sandbox
      // server id) so a fresh session paints the right models instantly. Only
      // genuine, model-bearing responses reach here, so the placeholder cache
      // is never poisoned with an empty list.
      setLSCache(LS_PROVIDERS, providers, cacheScope);
      return providers;
    },
    // Only ever serve a model-bearing placeholder. A previously-poisoned cache
    // (written before this guard existed) is ignored so it can't paint empty.
    placeholderData: () => {
      const cached = getLSCache<ProviderListResponse>(LS_PROVIDERS, cacheScope);
      if (!providerListHasModels(cached)) return undefined;
      // Old gateway caches may have been persisted before the source filter —
      // clean them on read, but native-mode workspaces must see the runtime's
      // actual provider list for v0.9.68/backward-compatible fallback.
      if (workspaceGatewayEnabled) {
        const gatewayProviders = filterToGatewayProviders(cached as ProviderListResponse);
        return providerListHasModels(gatewayProviders) ? gatewayProviders : undefined;
      }
      if (workspaceId && !workspaceGatewayEnabled) {
        const nativeProviders = filterToNativeProviders(cached as ProviderListResponse);
        return providerListHasModels(nativeProviders) ? nativeProviders : undefined;
      }
      return cached;
    },
    enabled: workspaceId ? workspaceModeKnown && (workspaceGatewayEnabled || runtimeReady) : runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // The boot race (sandbox up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: (failureCount) => failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });
}
