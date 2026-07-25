'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getWorkspaceModelPicker } from '../core/rest/workspaces-client';
import { type FlatModel, flattenModels } from './model-flatten';
import { workspaceLlmCatalogToProviderList } from './provider-selection';

/**
 * Server-side model list for a workspace — the model parallel to
 * `useVisibleAgents({ workspaceId })`. Reads the compact, connection-aware picker
 * catalog (`GET /workspaces/:id/model-picker`) and flattens it to `FlatModel[]`
 * with correct provider/model ids. Works before any sandbox runtime exists and
 * avoids transferring or scanning the complete runtime models.dev catalog.
 */
export function useWorkspaceModels(workspaceId: string | null | undefined): FlatModel[] {
  const { data } = useQuery({
    queryKey: ['workspace-model-picker', workspaceId],
    queryFn: () => getWorkspaceModelPicker(workspaceId as string),
    enabled: !!workspaceId,
    staleTime: 30_000,
    retry: false,
  });
  return useMemo(() => (data ? flattenModels(workspaceLlmCatalogToProviderList(data)) : []), [data]);
}
