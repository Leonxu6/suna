'use client';

import { useTranslations } from 'next-intl';

import { sessionDisplayLabel } from '@/components/workspaces/session-label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { useSidebar } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import { CompactModal } from '@/features/session/header/compact-modal';
import { ExportTranscriptModal } from '@/features/session/header/export-transcript-modal';
import { SessionChangesIndicator } from '@/features/session/header/session-changes-indicator';
import { SessionPendingApprovalsIndicator } from '@/features/session/header/session-pending-approvals-indicator';
import { useChatDetail } from '@/features/session/activity/chat-detail';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import { RenameSessionModal } from '@/features/workspace/workspace-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/workspace-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/workspace-sidebar/modal/share-session-modal';
import { desktopPlatform, isDesktop } from '@/lib/desktop';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { useReadyChip } from '@/stores/kortix-computer-store';
import {
  listWorkspaceSessions,
  restartWorkspaceSession,
  stopWorkspaceSession,
} from '@kortix/sdk';
import { HomeSolid, Pencil, Share, TrashSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Code2,
  FileDown,
  FolderOpen,
  Globe,
  Layers,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  ListTree,
  RotateCcw,
  Square,
  SquareTerminal,
  Text,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

interface SessionSiteHeaderProps {
  sessionId: string;
  sessionTitle: string;
  onToggleSidePanel: () => void;
  isSidePanelOpen?: boolean;
  isMobileView?: boolean;
  leadingAction?: React.ReactNode;
}

export function SessionSiteHeader({
  sessionId,
  sessionTitle,
  onToggleSidePanel,
  isSidePanelOpen = false,
  isMobileView,
  leadingAction,
}: SessionSiteHeaderProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  // Desktop shell with the sidebar hidden (offcanvas): this header reaches the
  // window's left edge, where the macOS traffic lights and the shell's
  // "Open sidebar" toggle (fixed at x 72–100) live — indent the leading
  // buttons past both and drop them onto the same center line (y≈26).
  const { state: sidebarState, toggleSidebar, peek, peekEnter, peekLeave } = useSidebar();
  const [desktopShell] = useState<'macos' | 'other' | null>(() =>
    isDesktop() ? (desktopPlatform() === 'macos' ? 'macos' : 'other') : null,
  );
  const sidebarHidden = desktopShell !== null && sidebarState === 'collapsed';
  const sidebarToggleLabel =
    sidebarState === 'expanded' ? 'Collapse sidebar' : peek ? 'Pin sidebar' : 'Open sidebar';

  const [exportOpen, setExportOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Lifecycle actions (Share / Restart / Delete) operate on the workspace-level
  // session, which is only addressable on the `/workspaces/:id/sessions/:id` route.
  const workspaceRoute = pathname?.match(/^\/workspaces\/([^/]+)\/sessions\/([^/]+)/);
  const workspaceId = workspaceRoute?.[1];
  const workspaceSessionId = workspaceRoute?.[2];
  const isWorkspaceSession = !!workspaceId && !!workspaceSessionId;

  const { data: workspaceSessions } = useQuery({
    queryKey: ['workspace-sessions', workspaceId],
    queryFn: () => listWorkspaceSessions(workspaceId!),
    enabled: isWorkspaceSession,
    staleTime: 10_000,
  });
  const workspaceSession = workspaceSessions?.find((s) => s.session_id === workspaceSessionId) ?? null;
  const canShare = !!workspaceSession && workspaceSession.can_manage_sharing !== false;

  const restartMutation = useMutation({
    mutationFn: () => restartWorkspaceSession(workspaceId!, workspaceSessionId!),
    onSuccess: () => {
      successToast('Restarting session…');
      queryClient.invalidateQueries({ queryKey: ['workspace-sessions', workspaceId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopWorkspaceSession(workspaceId!, workspaceSessionId!),
    onSuccess: () => {
      successToast('Session stopped');
      queryClient.invalidateQueries({ queryKey: ['workspace-sessions', workspaceId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to stop session');
    },
  });
  const canStop = !!workspaceSession && workspaceSession.status === 'running' && canShare;

  const readyChip = useReadyChip();
  const { detail: chatDetail, toggle: toggleChatDetail } = useChatDetail();

  return (
    <>
      <div className="relative z-50 w-full">
        {/* Hidden sidebar on desktop: drop the whole row onto the title-bar
            line (children h-[28px] → center y≈26, matching the traffic lights
            and the shell's Open-sidebar toggle), and indent the leading side
            past the lights + toggle. px values on purpose — the lights are
            OS-positioned; rem sizes drift with the root font. Both groups stay
            in flow so justify-between keeps the trailing cluster on the right. */}
        <div className={cn('flex items-center justify-between p-2', sidebarHidden && 'pt-[12px]')}>
          <div
            className={cn(
              'pointer-events-auto flex items-center gap-0.5 transition-[margin] duration-200 ease-linear',
              // Below md the shell floats an always-on sheet opener at this
              // row's left end (see WorkspaceSheelLayout) — indent past it.
              // 'max-md:ml-[34px]',
              sidebarHidden && 'h-[28px]',
              sidebarHidden && (desktopShell === 'macos' ? 'ml-[96px]' : 'ml-[32px]'),
            )}
          >
            {desktopShell === null && (
              <Button
                type="button"
                aria-label={sidebarToggleLabel}
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                onPointerEnter={sidebarState === 'collapsed' ? peekEnter : undefined}
                onPointerLeave={sidebarState === 'collapsed' ? peekLeave : undefined}
                className="hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
              >
                <PanelLeft className="cn-rtl-flip size-4" />
              </Button>
            )}

            {isWorkspaceSession && (
              <Button type="button" variant="ghost" size="icon" className="shrink-0" asChild>
                <Link href={`/workspaces/${workspaceId}`}>
                  <HomeSolid className="size-4.5" />
                </Link>
              </Button>
            )}
            {leadingAction}
          </div>

          <div
            className={cn(
              'pointer-events-auto flex items-center gap-1.5',
              sidebarHidden && 'h-[28px]',
            )}
          >
            {/* Resting header, non-technical default: identity (left, not
                ours) + these two indicators (self-hide via `return null`
                until there's something to see) + the panel toggle. Every
                icon-only control below carries a Hint label — nothing here
                is legible from the icon alone. */}
            <SessionChangesIndicator sessionId={sessionId} />

            <SessionPendingApprovalsIndicator sessionId={sessionId} />

            {/* Terminal / Browser / Files, grouped behind one "Developer
                tools" control (product owner's ask: "besides the show tool
                and specific things, all these terminals here should be
                perhaps grouped together" — three unlabeled icon buttons that
                spell out sandbox internals is exactly the thing a
                non-technical reader bounces off). Each item still fires the
                same `openSessionQuickView` call as before with the same
                'header' source, so nothing that worked stops working — it's
                one extra tap instead of a bare icon. */}
            <DropdownMenu>
              <Hint side="bottom" sideOffset={4} delayDuration={300} label="Developer tools">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Developer tools"
                    className="text-foreground/80 hover:text-foreground cursor-pointer transition-colors active:scale-[0.96]"
                  >
                    <Code2 className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>

              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => openSessionQuickView('terminal', 'header')}
                >
                  <SquareTerminal />
                  Terminal
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => openSessionQuickView('browser', 'header')}
                >
                  <Globe />
                  Browser
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => openSessionQuickView('files', 'header')}
                >
                  <FolderOpen />
                  Files
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <Hint
                side="bottom"
                label={tHardcodedUi.raw(
                  'componentsSessionSessionSiteHeader.line105JsxTextMoreActions',
                )}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tHardcodedUi.raw(
                      'componentsSessionSessionSiteHeader.line105JsxTextMoreActions',
                    )}
                    className="text-foreground/80 hover:text-foreground cursor-pointer transition-colors active:scale-[0.96]"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>

              {/* Rename/Share (identity) and Restart/Stop (lifecycle) sit at
                  full weight — those are what a normal user reaches for.
                  Export/Summarize are transcript-level, rarely-touched, and
                  jargon-adjacent (a non-technical reader has no idea what
                  "compacting" a session does), so they're visually
                  subordinate (muted text/icon) and pushed down next to
                  Delete. Delete stays the one destructive item and stays
                  last. The conditionals are arranged so a separator can
                  never lead, trail, or double up: within `isWorkspaceSession`
                  the first two groups always have at least Rename and
                  Restart, and the transcript group is unconditional. */}
              <DropdownMenuContent align="end" className="w-56">
                {/* Reading depth. It lived as a persistent button above the
                    transcript, which spent permanent chat real estate on a
                    setting most people touch once. It belongs with the other
                    per-session view actions. */}
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={(e) => {
                    e.preventDefault();
                    toggleChatDetail();
                  }}
                >
                  {chatDetail === 'full' ? <Text /> : <ListTree />}
                  {chatDetail === 'full' ? 'Hide full history' : 'Show full history'}
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                {isWorkspaceSession && (
                  <>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setRenameOpen(true)}
                    >
                      <Pencil />
                      {tI18nHardcoded.raw(
                        'autoFeaturesSessionHeaderSessionSiteHeaderJsxTextRename41731a53',
                      )}
                    </DropdownMenuItem>
                    {canShare && (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => setShareOpen(true)}
                      >
                        <Share />
                        {tI18nHardcoded.raw(
                          'autoFeaturesSessionHeaderSessionSiteHeaderJsxTextShared7d34d4f',
                        )}
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                      className="cursor-pointer"
                      disabled={restartMutation.isPending}
                      onClick={() => restartMutation.mutate()}
                    >
                      {restartMutation.isPending ? <Loading /> : <RotateCcw />}
                      Restart
                    </DropdownMenuItem>
                    {canStop && (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={stopMutation.isPending}
                        onClick={() => stopMutation.mutate()}
                      >
                        {stopMutation.isPending ? <Loading /> : <Square />}
                        Stop
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />
                  </>
                )}

                <DropdownMenuItem
                  className="text-muted-foreground hover:text-foreground/90 cursor-pointer [&_svg]:opacity-70"
                  onClick={() => setExportOpen(true)}
                >
                  <FileDown />
                  Export conversation
                </DropdownMenuItem>

                <DropdownMenuItem
                  className="text-muted-foreground hover:text-foreground/90 cursor-pointer [&_svg]:opacity-70"
                  onClick={() => setCompactOpen(true)}
                >
                  <Layers />
                  Summarize conversation
                </DropdownMenuItem>

                {isWorkspaceSession && (
                  <>
                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setDeleteOpen(true)}
                      variant="destructive"
                    >
                      <TrashSolid />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Hint
              side="bottom"
              sideOffset={4}
              delayDuration={300}
              label={
                <span className="flex items-center gap-1.5">
                  {isSidePanelOpen ? 'Close' : 'Open'} panel
                  <KbdGroup>
                    <Kbd className="font-mono">
                      {tHardcodedUi.raw('componentsSessionSessionSiteHeader.line185JsxTextI')}
                    </Kbd>
                  </KbdGroup>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (!isSidePanelOpen) track('panel_opened', { source: 'toggle' });
                  onToggleSidePanel();
                }}
                className={cn('text-foreground cursor-pointer transition-colors')}
              >
                <span className="relative inline-flex">
                  <PanelRight className="h-4 w-4" />
                  {readyChip?.sessionId === sessionId && !isSidePanelOpen && (
                    <span
                      className="bg-kortix-green ring-background absolute -top-1 -right-1 size-2 rounded-full ring-2"
                      aria-hidden
                    />
                  )}
                </span>
              </Button>
            </Hint>
          </div>
        </div>
      </div>

      <ExportTranscriptModal sessionId={sessionId} open={exportOpen} onOpenChange={setExportOpen} />
      <CompactModal sessionId={sessionId} open={compactOpen} onOpenChange={setCompactOpen} />

      {isWorkspaceSession && (
        <>
          <ShareSessionModal
            workspaceId={workspaceId!}
            session={workspaceSession}
            open={shareOpen}
            onOpenChange={setShareOpen}
            onSaved={() =>
              queryClient.invalidateQueries({ queryKey: ['workspace-sessions', workspaceId] })
            }
          />
          <RenameSessionModal
            workspaceId={workspaceId!}
            sessionId={workspaceSessionId!}
            currentName={workspaceSession ? sessionDisplayLabel(workspaceSession) : ''}
            open={renameOpen}
            onOpenChange={setRenameOpen}
          />
          <SessionDeleteModal
            workspaceId={workspaceId!}
            sessionId={workspaceSessionId!}
            sessionLabel={sessionTitle}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onDeleted={() => router.push(`/workspaces/${workspaceId}`)}
          />
        </>
      )}
    </>
  );
}
