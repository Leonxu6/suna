import { workspaceSessionStartSeed, type WorkspaceSession } from '@kortix/sdk';

export interface RunningSessionWarmupTarget {
  openCodeSessionId: string;
  runtimeUrl: string;
}

export function runningSessionWarmupTargets(
  sessions: WorkspaceSession[],
  activeSessionId: string | null,
): RunningSessionWarmupTarget[] {
  const targets: RunningSessionWarmupTarget[] = [];
  for (const session of sessions) {
    if (
      session.session_id === activeSessionId ||
      session.can_access === false ||
      !session.opencode_session_id
    ) {
      continue;
    }
    const runtimeUrl = workspaceSessionStartSeed(session)?.runtime_url;
    if (!runtimeUrl) continue;
    targets.push({
      openCodeSessionId: session.opencode_session_id,
      runtimeUrl,
    });
  }
  return targets;
}
