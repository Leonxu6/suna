'use client';

import { useTranslations } from 'next-intl';

/**
 * WorkspaceSwitcher — the standalone "which workspace" switcher.
 *
 * Scoped to the currently-selected account (account switching lives in the
 * Account·You menu, not here). Rendered in two places via `variant`:
 *  - `header`  — a compact pill in the top-bar breadcrumb.
 *  - `sidebar` — a full-width widget at the top of the workspace sidebar.
 *
 * Entity tiles use the design-system <EntityAvatar> (things are square).
 */

import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, FolderGit2, Search } from 'lucide-react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { listAccounts, listWorkspacesForAccount, type KortixWorkspace } from '@kortix/sdk';
import { cn } from '@/lib/utils';
import { shouldRenderWorkspaceSwitcher } from '@/lib/workspace-navigation';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useIsSwitchingWorkspace, useWorkspaceSwitchStore } from '@/stores/workspace-switch-store';
import { formatRelative } from '@kortix/shared';
import { CheckCircleSolid, ChevronsUpDownSolid } from '@mynaui/icons-react';

export type WorkspaceSwitcherVariant = 'header' | 'sidebar';

export function WorkspaceSwitcher({
  variant = 'header',
  className,
}: {
  variant?: WorkspaceSwitcherVariant;
  className?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { selectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useWorkspaceSwitchStore((s) => s.beginSwitch);
  const endSwitch = useWorkspaceSwitchStore((s) => s.endSwitch);
  const switching = useIsSwitchingWorkspace();

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!menuOpen) setQuery('');
  }, [menuOpen]);

  const activeWorkspaceId = pathname?.startsWith('/workspaces/') ? params?.id : undefined;

  // Account switching lives in the Account·You menu; here we just read the
  // selected account to scope the workspace list.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });
  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', activeAccount?.account_id],
    queryFn: () => listWorkspacesForAccount(activeAccount?.account_id),
    enabled: !!activeAccount,
    staleTime: 30_000,
  });

  const activeWorkspace = useMemo(
    () =>
      activeWorkspaceId && workspacesQuery.data
        ? (workspacesQuery.data.find((p) => p.workspace_id === activeWorkspaceId) ?? null)
        : null,
    [workspacesQuery.data, activeWorkspaceId],
  );

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const target = useWorkspaceSwitchStore.getState().targetWorkspaceId;
    if (target && target === activeWorkspaceId) endSwitch();
  }, [activeWorkspaceId, endSwitch]);

  const allWorkspacesSorted = useMemo(() => {
    const list = [...(workspacesQuery.data ?? [])];
    list.sort((a, b) => {
      const at = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0;
      const bt = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0;
      return bt - at;
    });
    return list;
  }, [workspacesQuery.data]);

  const showSearch = allWorkspacesSorted.length > 6;
  const filteredWorkspaces = useMemo(() => {
    if (!query.trim()) return allWorkspacesSorted.slice(0, 8);
    const q = query.trim().toLowerCase();
    return allWorkspacesSorted.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [allWorkspacesSorted, query]);

  const close = () => setMenuOpen(false);
  const switchWorkspace = (workspace: KortixWorkspace) => {
    if (workspace.workspace_id === activeWorkspaceId) return close();
    beginSwitch(workspace.workspace_id);
    close();
    router.push(`/workspaces/${workspace.workspace_id}`);
  };

  const label = activeWorkspace?.name ?? 'Workspaces';
  const tile = activeWorkspace ? (
    <EntityAvatar label={activeWorkspace.name} size={variant === 'header' ? 'xs' : 'sm'} />
  ) : (
    <EntityAvatar icon={FolderGit2} size={variant === 'header' ? 'xs' : 'sm'} />
  );

  const trigger =
    variant === 'header' ? (
      <Button type="button" className={cn(className)}>
        {tile}
        <span className="max-w-40 truncate text-sm font-medium">{label}</span>
        <ChevronsUpDownSolid className="text-muted-foreground size-3" />
      </Button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/trigger relative h-auto gap-2 border border-transparent bg-transparent px-1.5 py-1',
        )}
      >
        {tile}
        <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          {label}
        </span>
        <ChevronsUpDown className="text-muted-foreground/40 ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
      </SidebarMenuButton>
    );

  if (accountsQuery.isLoading && !activeAccount) {
    return variant === 'header' ? (
      <Skeleton className={cn('h-8 w-36 rounded-md', className)} />
    ) : (
      <Skeleton className="h-9 w-full rounded-lg" />
    );
  }

  if (
    !workspacesQuery.isLoading &&
    workspacesQuery.data &&
    !shouldRenderWorkspaceSwitcher(workspacesQuery.data)
  ) {
    return null;
  }

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        className={cn(
          'bg-background dark:bg-sidebar overflow-hidden p-0',
          variant === 'sidebar'
            ? 'w-(--radix-dropdown-menu-trigger-width) min-w-64 shadow-none'
            : 'w-64',
        )}
      >
        {showSearch && (
          <div className="border-border/40 border-b px-2 py-2">
            <div className="relative">
              <Search className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsLayoutWorkspaceSwitcher.line210JsxAttrPlaceholderFindWorkspace',
                )}
                className="placeholder:text-muted-foreground/50 h-8 pr-2 pl-7 text-sm"
              />
            </div>
          </div>
        )}

        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          <div className="max-h-[280px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {workspacesQuery.isLoading ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-7 rounded-md" />
                ))}
              </div>
            ) : filteredWorkspaces.length === 0 ? (
              <div className="text-muted-foreground/60 px-2 py-3 text-xs">
                {query.trim() ? 'No workspaces match' : 'No workspaces yet'}
              </div>
            ) : (
              filteredWorkspaces.map((workspace) => {
                const active = workspace.workspace_id === activeWorkspaceId;
                const loading = switching && workspace.workspace_id !== activeWorkspaceId;
                const relative = formatRelative(workspace.last_opened_at, { maxRelativeDays: 7 });
                return (
                  <DropdownMenuItem
                    key={workspace.workspace_id}
                    disabled={loading}
                    onSelect={() => switchWorkspace(workspace)}
                    className={cn('cursor-pointer', active && 'bg-muted/80')}
                  >
                    <EntityAvatar label={workspace.name} size="sm" />
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-sm font-medium">{workspace.name}</span>
                    </div>
                    {loading ? (
                      <Loading className="text-muted-foreground size-3.5" />
                    ) : active ? (
                      <CheckCircleSolid className="text-kortix-green size-3.5 shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="my-0" />

        <DropdownMenuGroup>
          <DropdownMenuItem
            className="cursor-pointer font-medium"
            onSelect={() => {
              close();
              router.push('/workspaces');
            }}
          >
            {tHardcodedUi.raw('componentsLayoutWorkspaceSwitcher.line281JsxTextAllWorkspaces')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer font-medium"
            onSelect={() => {
              close();
              router.push('/workspaces?new=1');
            }}
          >
            {tHardcodedUi.raw('componentsLayoutWorkspaceSwitcher.line293JsxTextNewWorkspace')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return variant === 'sidebar' ? (
    <SidebarMenu>
      <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
        {dropdown}
      </SidebarMenuItem>
    </SidebarMenu>
  ) : (
    dropdown
  );
}
