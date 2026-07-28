import type { QueryClient } from '@tanstack/react-query';

type SessionTitleQueryClient = Pick<QueryClient, 'getQueryData' | 'refetchQueries'>;

interface SessionTitleRefreshOptions {
  delaysMs?: number[];
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TITLE_REFRESH_DELAYS_MS = [0, 5_000, 5_000, 10_000, 10_000, 15_000, 20_000];

function readRealTitle(value: unknown): string | null {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || /^new session\b/i.test(title)) return null;
  return title;
}

export function readAcpSessionTitle(sessionInfo: Record<string, unknown> | null): string | null {
  return readRealTitle(sessionInfo?.title);
}

function cachedSessionHasTitle(
  queryClient: Pick<QueryClient, 'getQueryData'>,
  workspaceId: string,
  sessionId: string,
): boolean {
  const list = queryClient.getQueryData<unknown>(['workspace-sessions', workspaceId]);
  const detail = queryClient.getQueryData<unknown>(['workspace-session', workspaceId, sessionId]);
  const candidates = [...(Array.isArray(list) ? list : []), detail];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const session = candidate as Record<string, unknown>;
    const candidateId =
      typeof session.session_id === 'string'
        ? session.session_id
        : typeof session.sessionId === 'string'
          ? session.sessionId
          : null;
    if (candidateId !== sessionId) return false;
    return Boolean(readRealTitle(session.custom_name) || readRealTitle(session.name));
  });
}

function refetchSessionTitleQueries(
  queryClient: Pick<QueryClient, 'refetchQueries'>,
  workspaceId: string,
  sessionId: string,
): Promise<unknown[]> {
  return Promise.all([
    queryClient.refetchQueries({
      queryKey: ['workspace-sessions', workspaceId],
      type: 'active',
    }),
    queryClient.refetchQueries({
      queryKey: ['workspace-session', workspaceId, sessionId],
      type: 'active',
    }),
  ]);
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Refetch the authoritative Kortix session until its generated title appears.
 *
 * OpenCode generates titles asynchronously. ACP does not guarantee a
 * session_info_update notification, so runtime events are only a fast path.
 * This bounded loop covers both ACP and REST without permanent sidebar polling.
 */
export async function refreshSessionTitleQueryUntilResolved(
  queryClient: SessionTitleQueryClient,
  workspaceId: string,
  sessionId: string,
  options: SessionTitleRefreshOptions = {},
): Promise<boolean> {
  const delays = options.delaysMs ?? DEFAULT_TITLE_REFRESH_DELAYS_MS;
  const wait = options.sleep ?? sleep;

  for (const delayMs of delays) {
    await wait(delayMs, options.signal);
    if (options.signal?.aborted) return false;
    if (cachedSessionHasTitle(queryClient, workspaceId, sessionId)) return true;
    await refetchSessionTitleQueries(queryClient, workspaceId, sessionId);
    if (cachedSessionHasTitle(queryClient, workspaceId, sessionId)) return true;
  }
  return false;
}

export function syncAcpSessionTitleQuery(
  queryClient: Pick<QueryClient, 'refetchQueries'>,
  workspaceId: string,
  sessionId: string,
  sessionInfo: Record<string, unknown> | null,
): void {
  if (!readAcpSessionTitle(sessionInfo)) return;
  void refetchSessionTitleQueries(queryClient, workspaceId, sessionId);
}
