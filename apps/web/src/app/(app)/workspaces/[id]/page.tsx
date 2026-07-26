'use client';

import type { AttachedFile } from '@/features/session/session-chat-input';

import { buildNewSessionCreateInput } from '@/features/workspace/workspace-layout/new-session-create';
import {
  WorkspaceHome,
  type WorkspaceHomeSendOptions,
} from '@/features/workspace/workspace-layout/workspace-home';
import { useAccountState } from '@/hooks/billing';
import { useNewWorkspaceSession } from '@/hooks/workspaces/use-new-workspace-session';
import { useWorkspaceCanRun } from '@/hooks/workspaces/use-workspace-can-run';
import { useWarmWorkspaceSession } from '@/hooks/workspaces/use-warm-workspace-session';
import { isBillingEnabled } from '@/lib/config';
import { usePendingFilesStore } from '@/stores/session-composer-handoff-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getWorkspaceDetail } from '@kortix/sdk';
import { writeStartStash } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

const FREE_ONBOARDING_UPGRADE_MODAL_KEY = 'kortix:free-onboarding-upgrade-modal-shown';

export default function WorkspaceIndexPage() {
  const { id: workspaceId } = useParams<{ id: string }>();

  const { data: workspaceDetail } = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    queryFn: () => getWorkspaceDetail(workspaceId),
    enabled: !!workspaceId,
  });
  const workspaceAccountId = workspaceDetail?.workspace?.account_id ?? undefined;
  const { canRun, isLoading: billingLoading } = useWorkspaceCanRun(workspaceId);
  const { data: accountState } = useAccountState({ accountId: workspaceAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const warmSession = useWarmWorkspaceSession(workspaceId);
  const newSession = useNewWorkspaceSession(
    workspaceId,
    warmSession.data?.session,
    warmSession.resolveSession,
  );
  // Composer sending state: spans Enter → create confirmed → navigation. Reset
  // only on create failure (success navigates this page away).
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!isBillingEnabled() || !accountState || !workspaceAccountId) return;

    const tierKey = (
      accountState.subscription?.tier_key ||
      accountState.tier?.name ||
      ''
    ).toLowerCase();
    const hasActiveSubscription = !!accountState.subscription?.subscription_id;
    const shouldShow = (tierKey === 'free' || tierKey === 'none') && !hasActiveSubscription;
    if (!shouldShow) return;

    const storageKey = `${FREE_ONBOARDING_UPGRADE_MODAL_KEY}:${workspaceAccountId}`;
    if (window.localStorage.getItem(storageKey) === '1') return;

    window.localStorage.setItem(storageKey, '1');
    openUpgradeDialog({ reason: 'subscription_required', accountId: workspaceAccountId });
  }, [accountState, workspaceAccountId, openUpgradeDialog]);

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options?: WorkspaceHomeSendOptions) => {
      if (!text.trim() && !files?.length) return;

      if (isBillingEnabled() && billingLoading) return;

      // Gate accounts that cannot run before navigating so we never strand the
      // user on a shell that cannot provision. Free accounts with the monthly
      // sandbox grant are allowed through because `can_run` is true.
      const noPlan = isBillingEnabled() && !billingLoading && !canRun;
      if (noPlan) {
        openUpgradeDialog({ reason: 'subscription_required', accountId: workspaceAccountId });
        return;
      }

      // Identical create-first path to every other new-session entry point: the
      // composer shows a sending spinner for the create RTT (~one round trip),
      // then navigates into the instant shell, which auto-sends `text` once the
      // box is ready. No server-side initial_prompt — the shell shows the
      // message + inline boot status, matching the global dashboard composer.
      // Bind the chosen agent at session birth so it matches the `agent` the
      // composer sends on the first prompt — sessions are agent-immutable and the
      // API proxy 409s any prompt whose agent differs from the bound one, which
      // defaults to "default" when unset (see buildNewSessionCreateInput).
      setSending(true);
      newSession({
        create: buildNewSessionCreateInput(options),
        // Create failed (already surfaced by the hook) — we never left this
        // page, so just unlock the composer with the text still in it.
        onError: () => setSending(false),
        onNavigate: (sessionId) => {
          // `sessionId` here is the route/Kortix session id, not the OpenCode
          // pin the session page resolves later (`useCanonicalRuntimeSession`
          // /`ensureOpencodeSessionPin` mint a separate id). Stash under the
          // route id via the SDK's canonical `writeStartStash` — the session
          // page's `migrateStash` hands this off onto the resolved pin once it
          // exists, and `readStartStash` (instant shell, `useSession`) reads it
          // uniformly either side of that migration.
          writeStartStash(sessionId, {
            prompt: text,
            agent: options?.agent ?? null,
            model: options?.model ?? null,
            variant: options?.variant ?? null,
          });
          if (files?.length) {
            usePendingFilesStore.getState().setPendingFiles(files);
          }
        },
      });
    },
    [billingLoading, canRun, workspaceAccountId, openUpgradeDialog, newSession],
  );

  return <WorkspaceHome workspaceId={workspaceId} onSend={handleSend} busy={sending} />;
}
