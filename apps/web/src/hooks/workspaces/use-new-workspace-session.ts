'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';

import { errorToast, loadingToast } from '@/components/ui/toast';
import { resolveCreateFailure } from '@/hooks/workspaces/new-session-failure';
import {
  buildWarmSessionClaimInput,
  resolveWarmSessionForSend,
  shouldFallbackFromWarmClaim,
} from '@/hooks/workspaces/warm-session-create';
import { useWorkspaceCanRun } from '@/hooks/workspaces/use-workspace-can-run';
import { warmWorkspaceSessionKey } from '@/hooks/workspaces/use-warm-workspace-session';
import { isBillingEnabled } from '@/lib/config';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { markSessionFresh } from '@kortix/sdk/fresh-sessions';
import {
  claimWarmWorkspaceSession,
  type WorkspaceSession,
  type SessionConnectorBindings,
  createWorkspaceSession,
} from '@kortix/sdk';
import { prefetchSessionStart } from '@kortix/sdk/react';

/**
 * The ONE "new empty session" path, shared by every entry point (workspace shell
 * button, ⌘T/⌘J shortcuts, workspace sidebar, command palette, home composer).
 *
 * The workspace index supplies its server-owned warm session. Other entry points
 * mint the session id client-side and persist it before navigation. Both paths
 * prefetch the route bundle and `/start` before navigation.
 *
 * `onNavigate(sessionId)` runs synchronously right before the push — use it
 * for entry-point-specific side effects (open a tab, close a drawer, timing
 * marks, stashing a pending prompt so the shell auto-sends it once the box is
 * ready).
 *
 * `onError()` fires when the create fails (after the failure is surfaced per
 * `resolveCreateFailure`) — use it to reset an entry point's pending UI
 * (e.g. the home composer's sending spinner). No navigation has happened at
 * that point, so the user simply stays where they were.
 *
 * `create` carries create-time overrides (e.g. a chosen `sandbox_slug`)
 * straight to the persist POST.
 */
export function useNewWorkspaceSession(
  workspaceId: string | undefined,
  warmSession?: Pick<WorkspaceSession, 'session_id'>,
  resolveWarmSession?: () => Promise<
    Pick<WorkspaceSession, 'session_id'> | undefined
  >,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const creatingRef = useRef(false);
  const { canRun, isLoading: billingLoading, accountId } = useWorkspaceCanRun(workspaceId);
  const openUpgradeDialog = useUpgradeDialogStore((state) => state.openUpgradeDialog);

  return useCallback(
    (opts?: {
      onNavigate?: (sessionId: string) => void;
      onError?: () => void;
      // `agent_name` binds the session's immutable boot agent at birth. It MUST
      // match the agent the composer sends on the first prompt — the API proxy
      // rejects any prompt whose `agent` differs from the session's bound agent
      // with 409 AGENT_SWITCH_REQUIRES_NEW_SESSION (sessions are agent-immutable).
      // `connector_bindings` binds specific connection profiles for this session
      // (e.g. a member's own private connection); `inherit_unbound` keeps the
      // workspace-default fallback for every OTHER connector so binding one doesn't
      // null the rest. A member-owned binding also requires the session to be
      // private — which is already the create default.
      create?: {
        sandbox_slug?: string;
        agent_name?: string;
        connector_bindings?: SessionConnectorBindings;
        inherit_unbound?: boolean;
      };
    }) => {
      if (!workspaceId || creatingRef.current) {
        opts?.onError?.();
        return;
      }

      if (isBillingEnabled() && billingLoading) {
        opts?.onError?.();
        return;
      }

      if (isBillingEnabled() && !canRun) {
        openUpgradeDialog({ reason: 'subscription_required', accountId });
        opts?.onError?.();
        return;
      }

      creatingRef.current = true;

      const createNormalSession = async () => {
        const sessionId = crypto.randomUUID();
        markSessionFresh(sessionId);
        router.prefetch(`/workspaces/${workspaceId}/sessions/${sessionId}`);
        await loadingToast(
          'Starting session…',
          createWorkspaceSession(workspaceId, {
            session_id: sessionId,
            ...opts?.create,
          }),
          { success: 'Session started' },
        );
        return sessionId;
      };

      const claimOrCreate = async () => {
        const selectedWarmSession = await resolveWarmSessionForSend(
          warmSession,
          resolveWarmSession,
        );
        if (!selectedWarmSession) return createNormalSession();

        router.prefetch(
          `/workspaces/${workspaceId}/sessions/${selectedWarmSession.session_id}`,
        );
        try {
          const claimed = await claimWarmWorkspaceSession(
            workspaceId,
            buildWarmSessionClaimInput(selectedWarmSession, opts?.create),
          );
          return claimed.session_id;
        } catch (error) {
          if (shouldFallbackFromWarmClaim(error)) {
            return createNormalSession();
          }
          throw error;
        }
      };

      claimOrCreate()
        .then((sessionId) => {
          // The row exists — kick provisioning so it overlaps the navigation.
          prefetchSessionStart(queryClient, workspaceId, sessionId);
          queryClient.invalidateQueries({ queryKey: ['workspace-sessions', workspaceId] });
          opts?.onNavigate?.(sessionId);
          router.push(`/workspaces/${workspaceId}/sessions/${sessionId}`);
          queryClient.removeQueries({
            queryKey: warmWorkspaceSessionKey(workspaceId),
            exact: true,
          });
        })
        .catch((err) => {
          const code = (err as { code?: string })?.code;
          const action = resolveCreateFailure(code);
          if (action === 'upgrade') {
            openUpgradeDialog({ reason: 'subscription_required', accountId });
          } else if (action === 'toast') {
            errorToast(err instanceof Error ? err.message : 'Failed to start session');
          }
          // 'silent': the global 429 handler already surfaced the session cap.
          opts?.onError?.();
        })
        .finally(() => {
          creatingRef.current = false;
        });
    },
    [
      workspaceId,
      router,
      queryClient,
      billingLoading,
      canRun,
      accountId,
      openUpgradeDialog,
      warmSession,
      resolveWarmSession,
    ],
  );
}
