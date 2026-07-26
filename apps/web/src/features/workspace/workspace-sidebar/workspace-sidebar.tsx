'use client';

import {
  matchesSessionFilter,
  SESSION_FILTER_OPTIONS,
  type SessionFilterValue,
} from '@/components/workspaces/session-label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Icon } from '@/features/icon/icon';
import { UserMenu } from '@/features/layout/user-menu';
import { useAuth } from '@/features/providers/auth-provider';
import { WorkspaceChangeRequestsNavItem } from '@/features/workspace/workspace-sidebar/footer/workspace-change-requests-nav';
import { WorkspaceChatGptConnectNavItem } from '@/features/workspace/workspace-sidebar/footer/workspace-chatgpt-connect-nav';
import {
  WorkspaceCustomizeNavItem,
  WorkspaceFilesNavItem,
  useCustomizeKeyboardShortcut,
} from '@/features/workspace/workspace-sidebar/footer/workspace-customize-nav';
import { WorkspaceManifestUpgradeAlert } from '@/features/workspace/workspace-sidebar/footer/workspace-manifest-upgrade-alert';
import { WorkspaceSandboxAlert } from '@/features/workspace/workspace-sidebar/footer/workspace-sandbox-alert';
import { WorkspaceSessionList } from '@/features/workspace/workspace-sidebar/workspace-session-list';
import { WorkspaceSwitcher } from '@/features/workspace/workspace-sidebar/workspace-switcher';
import { useAdminRole } from '@/hooks/admin';
import { useNewWorkspaceSession } from '@/hooks/workspaces/use-new-workspace-session';
import { useIsMobile } from '@/hooks/utils';
import { beginSessionTiming, markSessionClick, sessionMark } from '@/lib/session-timing';
import { useBillingAccountId } from '@/stores/billing-account-context';
import { useSessionFilterStore } from '@/stores/session-filter-store';
import { listWorkspaceSessions } from '@kortix/sdk';
import { Icon as IconMynauiType, UsersSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, List, Mail, MessagesSquare, Webhook, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { HiDotsHorizontal } from 'react-icons/hi';
import { IconType } from 'react-icons/lib';
import { SidebarBalanceWarning } from './footer/workspace-balance-warning';
import { SidebarUpgradeButton } from './footer/workspace-upgrade-button';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';

const SESSION_FILTER_ICONS: Record<SessionFilterValue, LucideIcon | IconMynauiType | IconType> = {
  all: List,
  mine: MessagesSquare,
  shared: UsersSolid,
  slack: Icon.Slack,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

export function WorkspaceSidebar({ workspaceId }: { workspaceId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { state, setOpenMobile, holdPeek } = useSidebar();
  const isExpanded = state === 'expanded';
  const isMobile = useIsMobile();
  const sessionsGroupRef = useRef<HTMLDivElement>(null);

  // Filter lives in a persisted store (keyed by workspace) so it survives the
  // workspace shell remounting on navigation — local state reset to "all" on
  // every session open / ⌘J / switch.
  const sessionFilter = useSessionFilterStore((s) => s.filterByWorkspace[workspaceId] ?? 'all');
  const setSessionFilter = useSessionFilterStore((s) => s.setFilter);
  const { data: filterSessions } = useQuery({
    queryKey: ['workspace-sessions', workspaceId],
    queryFn: () => listWorkspaceSessions(workspaceId),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const sessionFilterCounts = useMemo(() => {
    const counts = new Map<SessionFilterValue, number>();
    for (const option of SESSION_FILTER_OPTIONS) {
      counts.set(
        option.value,
        (filterSessions ?? []).filter((s) => matchesSessionFilter(s, option.value)).length,
      );
    }
    return counts;
  }, [filterSessions]);
  const activeFilterOption =
    SESSION_FILTER_OPTIONS.find((option) => option.value === sessionFilter) ??
    SESSION_FILTER_OPTIONS[0];

  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  const accountId = useBillingAccountId();

  const { user: authUser } = useAuth();
  const user = useMemo(
    () => ({
      name: authUser?.user_metadata?.name || authUser?.email?.split('@')[0] || 'User',
      email: authUser?.email ?? '',
      avatar: authUser?.user_metadata?.avatar_url || authUser?.user_metadata?.picture || '',
      isAdmin,
    }),
    [authUser, isAdmin],
  );

  // Optimistic + shared with every other entry point (see useNewWorkspaceSession).
  // The timing marks + mobile-drawer close fire on the synchronous navigation.
  const newSession = useNewWorkspaceSession(workspaceId);
  const handleNewSession = useCallback(() => {
    markSessionClick();
    newSession({
      onNavigate: (sessionId) => {
        beginSessionTiming(sessionId);
        sessionMark(sessionId, 'session-created');
        if (isMobile) setOpenMobile(false);
      },
    });
  }, [newSession, isMobile, setOpenMobile]);

  useCustomizeKeyboardShortcut();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === 'j' || event.key === 'J')
      ) {
        event.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewSession]);

  return (
    <Sidebar
      collapsible="offcanvas"
      variant="inset"
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      <SidebarHeader className="space-y-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
        {/* Offcanvas everywhere: the whole panel slides, so the header keeps a
            single layout. The collapse toggle exists only while docked — in
            the flyout the shell's top-left toggle (right above the panel) is
            the pin control, and the workspace switcher takes the full width. */}
        <div className="flex w-full items-center justify-between gap-1">
          <Button type="button" variant="ghost" size="icon" asChild>
            <Link href={`/workspaces/${workspaceId}`}>
              <Icon.Kortix className="text-foreground size-4.5" />
            </Link>
          </Button>
          <div className="w-full min-w-0">
            <WorkspaceSwitcher variant="sidebar" />
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        <div className="flex h-full min-h-0 flex-col space-y-4">
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={handleNewSession}
                  size="md"
                  className="group/menu-button text-sidebar-foreground border-border dark:bg-background dark:hover:bg-background/90 bg-background hover:bg-background/90 relative flex items-center justify-center gap-2 border-[1.2px] text-center !text-sm font-medium [&_svg]:!size-4"
                >
                  <span>
                    {tI18nHardcoded.raw(
                      'autoFeaturesCoWorkerWorkspaceSidebarWorkspaceSidebarJsxTextNew55d0b491',
                    )}
                  </span>
                  <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/menu-button:opacity-100">
                    <Kbd>{modSymbol}</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            {/* Sessions are always expanded — no collapse toggle. The header
                label opens the full sessions page and carries the active
                filter; the ⋯ button opens the filter menu. */}
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
              <SidebarGroupLabel className="text-muted-foreground/60 mt-1 flex h-6 items-center px-0 text-[11px] font-medium tracking-wider uppercase">
                <div className="flex w-full flex-row items-center gap-0.5">
                  <Link
                    href={`/workspaces/${workspaceId}/sessions`}
                    className="hover:text-sidebar-foreground flex min-w-0 flex-1 flex-row items-center gap-1.5 self-stretch px-2 transition-colors duration-150"
                  >
                    <span>Sessions</span>
                    {sessionFilter !== 'all' && (
                      <span className="text-muted-foreground/90 truncate tracking-normal normal-case">
                        {tI18nHardcoded.raw(
                          'autoFeaturesCoWorkerWorkspaceSidebarWorkspaceSidebarJsxTextBulled44625b',
                        )}{' '}
                        {activeFilterOption.label}
                      </span>
                    )}
                  </Link>
                  <DropdownMenu onOpenChange={holdPeek}>
                    <DropdownMenuContent align="start" className="w-44 p-1">
                      {SESSION_FILTER_OPTIONS.map((option) => {
                        const OptionIcon = SESSION_FILTER_ICONS[option.value];
                        return (
                          <DropdownMenuItem
                            key={option.value}
                            className="cursor-pointer"
                            onClick={() => setSessionFilter(workspaceId, option.value)}
                          >
                            <OptionIcon className="h-4 w-4" />
                            {option.label}
                            <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs tabular-nums">
                              {sessionFilterCounts.get(option.value) ?? 0}
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuButton
                        type="button"
                        aria-label={tI18nHardcoded.raw(
                          'autoFeaturesCoWorkerWorkspaceSidebarWorkspaceSidebarJsxAttrAria39d6d82d',
                        )}
                        className="text-muted-foreground/90 hover:text-sidebar-foreground flex size-8 shrink-0 items-center justify-center px-2"
                      >
                        <HiDotsHorizontal className="size-3" />
                      </SidebarMenuButton>
                    </DropdownMenuTrigger>
                  </DropdownMenu>
                </div>
              </SidebarGroupLabel>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex h-full min-h-0 flex-col">
                  <WorkspaceSessionList workspaceId={workspaceId} filter={sessionFilter} />
                </div>
              </div>
            </div>
          </SidebarGroup>

          <SidebarGroup className="mt-auto py-0.5">
            <SidebarMenu>
              <WorkspaceSandboxAlert workspaceId={workspaceId} />
              <WorkspaceChangeRequestsNavItem workspaceId={workspaceId} />
              {/* Sits directly above Files/Customize so a still-on-v1 manifest
                  is impossible to miss — one click starts the migration session
                  end-to-end. Self-hides once the workspace is on v2. */}
              <WorkspaceManifestUpgradeAlert workspaceId={workspaceId} />
              {/* Files used to live on the collapsed icon rail; with the rail
                  gone (offcanvas + hover flyout) it needs a docked entry. Above
                  Customize — files aren't gated behind customize access. */}
              <WorkspaceFilesNavItem />
              <WorkspaceCustomizeNavItem />
              <WorkspaceChatGptConnectNavItem workspaceId={workspaceId} />
              <SidebarBalanceWarning accountId={accountId} />
              <SidebarUpgradeButton accountId={accountId} />
            </SidebarMenu>
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter className="space-y-0.5 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
        <UserMenu user={user} variant="sidebar" />
      </SidebarFooter>

      {/* No resize rail while collapsed — the edge is the hover-peek zone. */}
      {isExpanded && <SidebarRail />}
    </Sidebar>
  );
}
