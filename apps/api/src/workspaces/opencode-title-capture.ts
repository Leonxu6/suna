import { and, eq } from 'drizzle-orm';

import { workspaceSessions } from '@kortix/db';
import { db } from '../shared/db';
import { logger as appLogger } from '../lib/logger';
import { isPlaceholderOpencodeTitle, syncRowFromSandbox } from './opencode-title-sync';
import type { WorkspaceSessionRow } from './lib/serializers';

// Deferred title capture, scheduled off the prompt proxy path.
//
// Session read routes do not contact sandbox runtimes. The one moment a sandbox
// is guaranteed awake is after it served a prompt. OpenCode's summarizer
// produces the real title after the first reply. The proxy schedules capture
// here so title enrichment never delays a session list or detail response.
//
// Fire-and-forget by design: never blocks or fails the prompt request, one
// pending capture per session, a single retry when the summarizer hasn't
// produced a title yet by the first attempt.
const FIRST_ATTEMPT_DELAY_MS = 20_000;
const RETRY_DELAY_MS = 40_000;

const pending = new Set<string>();

function hasRealTitle(row: WorkspaceSessionRow): boolean {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.custom_name === 'string' && metadata.custom_name.trim()) return true;
  const name = typeof metadata.name === 'string' ? metadata.name : null;
  return Boolean(name && !isPlaceholderOpencodeTitle(name));
}

async function loadRow(sessionId: string, workspaceId: string): Promise<WorkspaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(workspaceSessions)
    .where(and(eq(workspaceSessions.sessionId, sessionId), eq(workspaceSessions.workspaceId, workspaceId)))
    .limit(1);
  return (row as WorkspaceSessionRow | undefined) ?? null;
}

/** Injectable seams so unit tests run without process-global module mocks. */
export interface TitleCaptureOptions {
  firstMs?: number;
  retryMs?: number;
  loadRow?: (sessionId: string, workspaceId: string) => Promise<WorkspaceSessionRow | null>;
  sync?: typeof syncRowFromSandbox;
}

/**
 * Schedule a deferred title capture for a session that just served a prompt.
 * Safe to call on every prompt — deduped per session, and each attempt exits
 * immediately once the session already has a real (or user-set) title.
 */
export function scheduleTitleCaptureAfterPrompt(
  input: {
    sessionId: string;
    workspaceId: string;
    externalId: string;
    userId?: string;
  },
  options: TitleCaptureOptions = {},
): void {
  if (!input.sessionId || !input.workspaceId || !input.externalId) return;
  if (pending.has(input.sessionId)) return;
  pending.add(input.sessionId);

  const firstMs = options.firstMs ?? FIRST_ATTEMPT_DELAY_MS;
  const retryMs = options.retryMs ?? RETRY_DELAY_MS;
  const load = options.loadRow ?? loadRow;
  const sync = options.sync ?? syncRowFromSandbox;

  const attempt = async (): Promise<boolean> => {
    const row = await load(input.sessionId, input.workspaceId);
    if (!row) return true; // session gone — nothing to do
    if (hasRealTitle(row)) return true;
    const synced = await sync({ row, externalId: input.externalId, userId: input.userId });
    return hasRealTitle(synced);
  };

  const run = async () => {
    try {
      const done = await attempt();
      if (done) return;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      await attempt();
    } catch (err) {
      // Best-effort enrichment: a failed capture must never surface — the
      // The next prompt schedules another capture attempt.
      appLogger.warn('[title-capture] deferred capture failed', {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pending.delete(input.sessionId);
    }
  };

  setTimeout(() => void run(), firstMs);
}

/** Test hook: number of sessions with a capture in flight. */
export function pendingTitleCaptures(): number {
  return pending.size;
}
