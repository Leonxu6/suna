'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { PersonalOnboardingWelcome } from '@/components/workspaces/personal-onboarding-welcome';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { UpgradeButton } from '@/features/billing/upgrade-button';
import { Icon } from '@/features/icon/icon';
import { AppHeader } from '@/features/layout/app-header';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { RenameWorkspaceDialog } from '@/features/workspaces/modal/rename-workspace-modal';
import { WorkspaceCreateModal } from '@/features/workspaces/modal/workspace-create-modal';
import NewWorkspaceControl from '@/features/workspaces/new-workspace-control';
import WorkspaceCard from '@/features/workspaces/workspace-card';
import { invalidateAccountState, useAccountState } from '@/hooks/billing';
import { fireConfetti } from '@/lib/confetti';
import { isBillingEnabled } from '@/lib/config';
import {
  ensureFirstWorkspace,
  hasFirstWorkspaceBootstrapSignal,
  shouldAutoCreateFirstWorkspace,
} from '@/lib/onboarding/ensure-first-workspace';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  type KortixWorkspace,
  archiveWorkspace,
  listAccounts,
  listWorkspacesForAccount,
  syncSubscription,
} from '@kortix/sdk';
import { Search } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const WORKSPACE_SKELETON_KEYS = Array.from(
  { length: 6 },
  (_, index) => `workspace-skeleton-${index}`,
);

/**
 * The one loading state for this page. Auth gate, first-workspace bootstrap, and
 * the in-list fetch all resolve to the same skeleton grid — no progress line, no
 * connecting shell — so nothing else ever flashes before the workspaces land.
 */
function WorkspacesLoadingScreen({ standalone }: { standalone: boolean }) {
  return (
    <div className={standalone ? 'flex min-h-screen flex-col' : 'contents'}>
      {standalone ? (
        <div className="w-full border-b">
          <div className="kx-app-header px-mobile mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-2 py-4 sm:gap-3">
            <Skeleton className="h-5 w-24 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-full" />
          </div>
        </div>
      ) : null}
      <div className={standalone ? 'bg-background px-mobile flex-1 py-10 sm:py-12' : undefined}>
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <div className="space-y-2">
            <Skeleton className="h-9 w-44 rounded-md" />
            <Skeleton className="h-5 w-80 max-w-full rounded-md" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WORKSPACE_SKELETON_KEYS.map((key) => (
              <Skeleton key={key} className="h-[92px] rounded-md" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WorkspacesPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const { id: routeAccountId } = useParams<{ id?: string }>();
  const standalone = pathname === '/workspaces';
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [query, setQuery] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<KortixWorkspace | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<KortixWorkspace | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [createAccountId, setCreateAccountId] = useState<string | null>(null);
  const [cloneSourceItemId, setCloneSourceItemId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const [firstWorkspaceBootstrapRequested, setFirstWorkspaceBootstrapRequested] = useState(() => {
    return hasFirstWorkspaceBootstrapSignal(searchParams);
  });

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModalOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      window.history.replaceState(null, '', url.toString());
    }
  }, [searchParams]);

  // "Clone workspace" from the public marketplace (?clone=<item-id>) — opens the
  // same New Workspace modal pre-seeded from a `registry:project` item instead
  // of the blank starter, same auto-open-then-strip-the-param pattern as `new`.
  useEffect(() => {
    const cloneId = searchParams.get('clone');
    if (cloneId) {
      setCloneSourceItemId(cloneId);
      setModalOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('clone');
      window.history.replaceState(null, '', url.toString());
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get('team_signup') !== 'success') return;
    let cancelled = false;
    (async () => {
      try {
        await syncSubscription();
        if (cancelled) return;
        await invalidateAccountState(queryClient);
        fireConfetti();
        successToast('Subscription activated', {
          description: 'Your team is on Kortix Team. Compute and LLM credits are ready.',
        });
      } catch {
        invalidateAccountState(queryClient);
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete('team_signup');
        window.history.replaceState(null, '', url.toString());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, queryClient]);

  // Stripe credit-purchase return. The webhook grants the credits server-side;
  // here we just refetch the wallet so the new balance shows immediately, then
  // celebrate. Mirrors the team_signup handler above.
  useEffect(() => {
    if (searchParams.get('credit_purchase') !== 'success') return;
    let cancelled = false;
    (async () => {
      try {
        await invalidateAccountState(queryClient, true);
        if (cancelled) return;
        fireConfetti();
        successToast('Credits added', {
          description: 'Your top-up landed — compute and the latest AI models are ready to go.',
        });
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete('credit_purchase');
        window.history.replaceState(null, '', url.toString());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, queryClient]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

  const activeAccount = routeAccountId
    ? (accountsQuery.data?.find((account) => account.account_id === routeAccountId) ?? null)
    : (accountsQuery.data?.find((account) => account.account_id === selectedAccountId) ??
      accountsQuery.data?.[0] ??
      null);
  const activeAccountId = activeAccount?.account_id ?? null;

  useEffect(() => {
    if (!activeAccount) return;
    if (activeAccount.account_id !== selectedAccountId) {
      setSelectedAccountId(activeAccount.account_id);
    }
  }, [activeAccount, selectedAccountId, setSelectedAccountId]);

  useEffect(() => {
    if (!routeAccountId || !accountsQuery.data || activeAccount) return;
    router.replace('/workspaces');
  }, [routeAccountId, accountsQuery.data, activeAccount, router]);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', activeAccountId],
    queryFn: () => listWorkspacesForAccount(activeAccountId || undefined),
    enabled: !!user && !!activeAccountId,
    staleTime: 20_000,
  });

  const canCreateWorkspaces =
    activeAccount?.account_role === 'owner' || activeAccount?.account_role === 'admin';

  const creatableAccounts = useMemo(
    () => (activeAccount && canCreateWorkspaces ? [activeAccount] : []),
    [activeAccount, canCreateWorkspaces],
  );

  const filterWorkspaces = useCallback(
    (items: KortixWorkspace[]) => {
      const q = query.trim().toLowerCase();
      if (!q) return items;
      return items.filter((workspace) =>
        [workspace.name, workspace.repo_url, workspace.default_branch]
          // repo_url / default_branch can be null for repo-less workspaces;
          // optional chaining short-circuits the whole chain to undefined.
          .some((value) => value?.toLowerCase().includes(q)),
      );
    },
    [query],
  );

  // ── Onboarding: only explicit signup/subscription returns auto-bootstrap the
  // first workspace. A normal empty workspaces list can come from deleting the last
  // workspace, and must stay empty instead of recreating it.
  const { data: accountState, isLoading: accountStateLoading } = useAccountState({
    accountId: activeAccountId ?? undefined,
    enabled: !!user && !!activeAccountId,
  });
  const autoCreateAttempted = useRef<Set<string>>(new Set());
  const [autoCreating, setAutoCreating] = useState(false);

  useEffect(() => {
    const accountId = activeAccountId;
    if (
      !shouldAutoCreateFirstWorkspace({
        bootstrapRequested: firstWorkspaceBootstrapRequested,
        activeAccountId: accountId,
        canCreateWorkspaces,
        autoCreateAttempted: accountId ? autoCreateAttempted.current.has(accountId) : false,
        accountsLoading: accountsQuery.isLoading,
        workspacesLoading: workspacesQuery.isLoading,
        workspacesError: workspacesQuery.isError,
        workspacesLoaded: !!workspacesQuery.data,
        workspaceCount: workspacesQuery.data?.length ?? 0,
        legacyMachinesLoaded: true,
        legacyMachineCount: 0,
        billingEnabled: isBillingEnabled(),
        accountStateLoading,
        canRun: !!accountState?.credits?.can_run,
      })
    ) {
      return;
    }
    if (!accountId) return;

    autoCreateAttempted.current.add(accountId);
    setFirstWorkspaceBootstrapRequested(false);
    setAutoCreating(true);
    ensureFirstWorkspace(accountId)
      .then((workspace) => {
        if (!workspace) {
          setAutoCreating(false);
          setCreateAccountId(accountId);
          setModalOpen(true);
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['workspaces', accountId] });
        router.replace(`/workspaces/${workspace.workspace_id}`);
      })
      .catch((err) => {
        autoCreateAttempted.current.delete(accountId);
        setAutoCreating(false);
        console.error('[onboarding] auto-create first workspace failed', err);
      });
  }, [
    activeAccountId,
    canCreateWorkspaces,
    accountsQuery.isLoading,
    workspacesQuery.isLoading,
    workspacesQuery.isError,
    workspacesQuery.data,
    firstWorkspaceBootstrapRequested,
    accountStateLoading,
    accountState?.credits?.can_run,
    queryClient,
    router,
  ]);

  const archiveMutation = useMutation({
    mutationFn: archiveWorkspace,
    onMutate: (workspaceId) => setArchivingId(workspaceId),
    onSettled: () => setArchivingId(null),
    onSuccess: (_data, workspaceId) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      const name = workspaceId === archiveTarget?.workspace_id ? archiveTarget?.name : undefined;
      successToast(name ? `"${name}" archived` : 'Workspace archived');
      setArchiveTarget(null);
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to archive workspace');
    },
  });

  const confirmArchive = () => {
    if (!archiveTarget || archiveMutation.isPending) return;
    archiveMutation.mutate(archiveTarget.workspace_id);
  };

  const filtered = useMemo(
    () => filterWorkspaces(workspacesQuery.data ?? []),
    [filterWorkspaces, workspacesQuery.data],
  );

  if (authLoading || !user) {
    return <WorkspacesLoadingScreen standalone={standalone} />;
  }

  // Bootstrapping the first workspace — hold the skeleton instead of flashing the
  // empty "create your first workspace" state before the redirect.
  if (autoCreating) {
    return <WorkspacesLoadingScreen standalone={standalone} />;
  }

  const total = workspacesQuery.data?.length ?? 0;
  const showWorkspacesLoading = accountsQuery.isLoading || workspacesQuery.isLoading;
  const showEmptyState =
    !!activeAccountId && !showWorkspacesLoading && !workspacesQuery.isError && total === 0;
  const showNoResults =
    !!activeAccountId &&
    !showWorkspacesLoading &&
    !workspacesQuery.isError &&
    total > 0 &&
    filtered.length === 0;

  const openCreateModal = (accountId: string | null) => {
    setCreateAccountId(accountId);
    setModalOpen(true);
  };

  return (
    <div className={standalone ? 'flex min-h-screen flex-col' : 'contents'}>
      {standalone ? (
        <div className="w-full border-b">
          <AppHeader
            user={user}
            breadcrumb="Workspaces"
            actions={<UpgradeButton accountId={activeAccountId ?? undefined} />}
          />
        </div>
      ) : null}
      <div className={standalone ? 'bg-background px-mobile flex-1 py-10 sm:py-12' : undefined}>
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 space-y-1">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
                Workspaces
              </h1>
              <p className="text-muted-foreground text-base">
                {tHardcodedUi.raw(
                  'appWorkspacesPage.line216JsxTextYourWorkspacesOnePlacePickUpWhereYou',
                )}
              </p>
            </div>
            <div className="flex w-full min-w-0 flex-col gap-3 lg:w-auto lg:flex-row lg:items-center lg:gap-2">
              <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center lg:w-auto">
                <div className="relative min-w-0 flex-1 lg:w-72 lg:flex-none">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={tHardcodedUi.raw(
                      'appWorkspacesPage.line225JsxAttrPlaceholderSearchWorkspaces',
                    )}
                    className="bg-foreground/10 w-full pl-9 text-sm"
                  />
                </div>
                <NewWorkspaceControl
                  viewAll={false}
                  creatableAccounts={creatableAccounts}
                  activeAccountId={activeAccountId}
                  canCreateActive={canCreateWorkspaces}
                  onPick={openCreateModal}
                  label={tHardcodedUi.raw('appWorkspacesPage.line236JsxTextNewWorkspace')}
                  fullWidth
                  className="sm:w-auto"
                />
              </div>
            </div>
          </div>

          {showWorkspacesLoading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {WORKSPACE_SKELETON_KEYS.map((key) => (
                <Skeleton key={key} className="h-[92px] rounded-md" />
              ))}
            </div>
          )}

          {workspacesQuery.isError && (
            <ErrorState
              title={tHardcodedUi.raw(
                'appWorkspacesPage.line252JsxAttrTitleFailedToLoadWorkspaces',
              )}
              description={(workspacesQuery.error as Error).message}
              action={
                <Button variant="outline" size="sm" onClick={() => workspacesQuery.refetch()}>
                  Retry
                </Button>
              }
            />
          )}

          {showEmptyState && (
            <EmptyState
              icon={FolderPlus}
              title={tI18nHardcoded.raw(
                'autoAppAppWorkspacesPageJsxAttrTitleNoWorkspacesYet85527dd3',
              )}
              description={tI18nHardcoded.raw(
                'autoAppAppWorkspacesPageJsxAttrDescriptionAWorkspaceIsa4dc84d2',
              )}
              action={
                <Button
                  onClick={() => openCreateModal(activeAccountId)}
                  disabled={!canCreateWorkspaces}
                >
                  <Icon.Plus />
                  {tI18nHardcoded.raw(
                    'autoAppAppWorkspacesPageJsxTextCreateYourFirstWorkspace061cafdb',
                  )}
                </Button>
              }
            />
          )}

          {showNoResults && (
            <EmptyState
              icon={Search}
              size="sm"
              title={`No matches for "${query}"`}
              description={tHardcodedUi.raw(
                'appWorkspacesPage.line288JsxAttrDescriptionTryADifferentSearchTerm',
              )}
            />
          )}

          {filtered.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((workspace) => (
                <WorkspaceCard
                  key={workspace.workspace_id}
                  workspace={workspace}
                  onOpen={() => router.push(`/workspaces/${workspace.workspace_id}`)}
                  onRename={() => setRenameTarget(workspace)}
                  onArchive={() => setArchiveTarget(workspace)}
                  archiving={archivingId === workspace.workspace_id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <WorkspaceCreateModal
        open={modalOpen}
        onOpenChange={(o) => {
          setModalOpen(o);
          if (!o) {
            setCreateAccountId(null);
            setCloneSourceItemId(null);
          }
        }}
        accountId={createAccountId ?? activeAccountId}
        sourceItemId={cloneSourceItemId}
      />

      <RenameWorkspaceDialog
        workspaceId={renameTarget?.workspace_id ?? null}
        currentName={renameTarget?.name}
        open={!!renameTarget}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
      />

      <ConfirmDialog
        open={!!archiveTarget}
        onOpenChange={(o) => {
          if (!o && !archiveMutation.isPending) setArchiveTarget(null);
        }}
        title="Archive workspace"
        description={
          <>
            <span className="text-foreground font-medium">{archiveTarget?.name}</span> will be
            archived and removed from your workspaces list.
          </>
        }
        confirmLabel="Archive"
        confirmVariant="destructive"
        isPending={archiveMutation.isPending}
        onConfirm={confirmArchive}
      />

      <PersonalOnboardingWelcome />
      {isBillingEnabled() && <GlobalUpgradeModal />}
    </div>
  );
}
