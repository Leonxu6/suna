'use client';

import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { getWorkspaceDetail } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

export function useWorkspaceCanRun(workspaceId: string | undefined) {
  const { data: workspaceDetail, isLoading: workspaceLoading } = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    queryFn: () => {
      if (!workspaceId) throw new Error('Missing workspace id');
      return getWorkspaceDetail(workspaceId);
    },
    enabled: !!workspaceId,
  });

  const accountId = workspaceDetail?.workspace?.account_id ?? undefined;
  const { data: accountState, isLoading: accountLoading } = useAccountState({
    accountId,
    enabled: !!accountId,
  });

  if (!isBillingEnabled()) {
    return { canRun: true, isLoading: false, accountId };
  }

  if (!workspaceId || workspaceLoading || (accountId && accountLoading)) {
    return { canRun: false, isLoading: true, accountId };
  }

  if (!accountId) {
    return { canRun: false, isLoading: false, accountId };
  }

  return {
    canRun: accountState?.credits?.can_run ?? false,
    isLoading: false,
    accountId,
  };
}
