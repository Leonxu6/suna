'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  selectAccountWorkspace,
  workspaceManagementPath,
} from '@/lib/workspace-navigation';
import {
  listAccounts,
  listWorkspacesForAccount,
  provisionWorkspace,
  type KortixAccount,
} from '@kortix/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';

function WorkspaceResolverLoading() {
  return (
    <main
      className="bg-background flex min-h-screen items-center justify-center px-4"
      aria-label="Opening workspace"
    >
      <div className="w-full max-w-md space-y-3">
        <Skeleton className="mx-auto size-10 rounded-md" />
        <Skeleton className="mx-auto h-5 w-40 rounded-md" />
        <Skeleton className="mx-auto h-4 w-64 max-w-full rounded-md" />
      </div>
    </main>
  );
}

export default function WorkspaceResolverPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const provisioningAccounts = useRef(new Set<string>());

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

  const activeAccount = useMemo<KortixAccount | null>(() => {
    const accounts = accountsQuery.data ?? [];
    return (
      accounts.find((account) => account.account_id === selectedAccountId) ??
      accounts[0] ??
      null
    );
  }, [accountsQuery.data, selectedAccountId]);

  useEffect(() => {
    if (activeAccount && activeAccount.account_id !== selectedAccountId) {
      setSelectedAccountId(activeAccount.account_id);
    }
  }, [activeAccount, selectedAccountId, setSelectedAccountId]);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', activeAccount?.account_id],
    queryFn: () => listWorkspacesForAccount(activeAccount?.account_id),
    enabled: !!activeAccount,
    staleTime: 20_000,
  });

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/auth');
      return;
    }
    if (!activeAccount || !workspacesQuery.data) return;

    const managementQuery = searchParams.toString();
    if (managementQuery) {
      router.replace(workspaceManagementPath(activeAccount.account_id, managementQuery));
      return;
    }

    const workspaces = workspacesQuery.data;
    const defaultWorkspace = selectAccountWorkspace(activeAccount, workspaces);
    if (defaultWorkspace) {
      router.replace(`/workspaces/${defaultWorkspace.workspace_id}`);
      return;
    }

    const canCreate =
      activeAccount.account_role === 'owner' || activeAccount.account_role === 'admin';
    if (!canCreate || provisioningAccounts.current.has(activeAccount.account_id)) {
      router.replace(workspaceManagementPath(activeAccount.account_id, 'creation_failed=1'));
      return;
    }

    provisioningAccounts.current.add(activeAccount.account_id);
    void provisionWorkspace({
      account_id: activeAccount.account_id,
      name: activeAccount.name || 'Workspace',
      seed_starter: true,
      starter_template: 'general-knowledge-worker',
    })
      .then((workspace) => {
        queryClient.setQueryData(
          ['workspaces', activeAccount.account_id],
          [workspace],
        );
        void queryClient.invalidateQueries({ queryKey: ['accounts'] });
        router.replace(`/workspaces/${workspace.workspace_id}`);
      })
      .catch(() => {
        router.replace(workspaceManagementPath(activeAccount.account_id, 'creation_failed=1'));
      });
  }, [
    activeAccount,
    authLoading,
    queryClient,
    router,
    searchParams,
    user,
    workspacesQuery.data,
  ]);

  return <WorkspaceResolverLoading />;
}
