'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { WorkspaceProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { useLlmProviderCatalogRevision } from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getWorkspaceDetail, listWorkspaceSecrets } from '@kortix/sdk';
import { connectedGatewayProviderIdsFromSecretNames, hasUsableModel } from '@kortix/sdk/react';
import type { FlatModel } from './session-chat-input';

export function workspaceProviderModalTab(tab: ProviderModalTab): 'connected' | 'catalog' | 'models' {
  return tab === 'providers' ? 'catalog' : tab;
}

/**
 * Shared "connect a model" routing. Workspace actions open the workspace-scoped
 * provider modal in place. Non-workspace actions use the global provider modal.
 * Extracted from `ModelSelector` so the picker, chat gate, and onboarding use
 * the same surface.
 *
 * Also computes `hasSelectableModels` — pass the caller's flattened model list
 * (default `[]` for callers that only need the routing actions). This is
 * deliberately NOT `models.length > 0` or a raw provider-connected check: the
 * gateway bakes its whole catalog into every workspace regardless of plan or
 * connected keys, so the raw list is basically never empty. See
 * `hasUsableModel` for the actual entitlement check.
 */
export function useModelConnectionGate(models: FlatModel[] = []) {
  // See use-connected-providers.ts: re-renders when LlmCatalogBootstrap's
  // live-catalog fetch lands, since connectedProviderIds below reads the
  // module-level LLM_PROVIDERS binding.
  const catalogRevision = useLlmProviderCatalogRevision();
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const params = useParams<{ id?: string }>();
  const workspaceId = typeof params?.id === 'string' ? params.id : null;

  const workspaceDetailQuery = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    queryFn: () => getWorkspaceDetail(workspaceId as string),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(workspaceDetailQuery.data?.workspace);
  const canWriteProviders =
    useWorkspaceCan(workspaceId ?? undefined, WORKSPACE_ACTIONS.WORKSPACE_WRITE, {
      accountId: workspaceDetailQuery.data?.workspace.account_id,
    }).allowed === true;

  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceModalTab, setWorkspaceModalTab] = useState<'connected' | 'catalog' | 'models'>(
    'catalog',
  );

  // Same entitlement inputs ModelSelector uses: which BYOK providers are
  // connected (from workspace secrets), and whether the account is on free
  // tier (hides Kortix-managed models — they paywall server-side otherwise).
  const baseModels = useMemo(
    () => (llmGatewayEnabled ? models : models.filter((m) => m.providerID !== 'kortix')),
    [models, llmGatewayEnabled],
  );
  const secretsQuery = useQuery({
    queryKey: ['workspace-secrets', workspaceId],
    queryFn: () => listWorkspaceSecrets(workspaceId as string),
    enabled: !!workspaceId && llmGatewayEnabled,
    staleTime: 10_000,
  });
  const connectedProviderIds = useMemo(() => {
    if (!llmGatewayEnabled) return new Set<string>();
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    const secretNames = new Set(items.map((secret: { name: string }) => secret.name));
    return connectedGatewayProviderIdsFromSecretNames(secretNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogRevision drives a re-read of the module-level LLM_PROVIDERS binding, not a value used directly here
  }, [llmGatewayEnabled, secretsQuery.data, catalogRevision]);
  const { data: accountState, isPending: accountStatePending } = useAccountState();
  const freeTier = useMemo(() => {
    const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
    const hasActiveSubscription = !!accountState?.subscription?.subscription_id;
    return (tierKey === 'free' || tierKey === 'none') && !hasActiveSubscription;
  }, [accountState]);
  const hasSelectableModels = useMemo(
    () =>
      hasUsableModel(baseModels, { connectedProviderIds, freeTier: llmGatewayEnabled && freeTier }),
    [baseModels, connectedProviderIds, llmGatewayEnabled, freeTier],
  );
  // `hasSelectableModels` is only trustworthy once every entitlement input has
  // loaded — before that, a subscribed account with zero BYOK keys computes as
  // "nothing usable" (accountState undefined → freeTier, secrets undefined →
  // no connected providers) and any gate keyed on it flashes, then vanishes.
  // Disabled queries stay `isPending` forever, so each is guarded by its
  // `enabled` condition.
  const entitlementsPending =
    (!!workspaceId && workspaceDetailQuery.isPending) ||
    (!!workspaceId && llmGatewayEnabled && secretsQuery.isPending) ||
    accountStatePending;

  const openConnectProvider = useCallback(
    (tab: ProviderModalTab = 'providers') => {
      if (workspaceId) {
        setWorkspaceModalTab(workspaceProviderModalTab(tab));
        setWorkspaceModalOpen(true);
        return;
      }
      openProviderModal(tab);
    },
    [workspaceId, openProviderModal],
  );

  const openUpgrade = useCallback(() => {
    openUpgradeDialog({
      reason: 'subscription_required',
      accountId: workspaceDetailQuery.data?.workspace.account_id,
    });
  }, [openUpgradeDialog, workspaceDetailQuery.data?.workspace.account_id]);

  const modal = workspaceId ? (
    <WorkspaceProviderModal
      workspaceId={workspaceId}
      open={workspaceModalOpen}
      onOpenChange={setWorkspaceModalOpen}
      defaultTab={workspaceModalTab}
      canWrite={canWriteProviders}
    />
  ) : null;

  // Billing off (self-host default): there's no Kortix plan to upgrade to and
  // no <GlobalUpgradeModal/> mounted anywhere to respond to openUpgrade() (see
  // app-providers.tsx's `isBillingEnabled() && <GlobalUpgradeModal />`) — an
  // "Upgrade" button would be a dead click. Callers should hide it and only
  // offer "bring your own key" when this is false.
  const showUpgradeOption = isBillingEnabled();

  return {
    openConnectProvider,
    openUpgrade,
    modal,
    hasSelectableModels,
    entitlementsPending,
    showUpgradeOption,
  };
}
