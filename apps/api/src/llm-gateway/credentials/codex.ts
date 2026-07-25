import { and, eq, isNull, or } from 'drizzle-orm';
import { workspaceSecrets } from '@kortix/db';
import { db } from '../../shared/db';
import { decryptWorkspaceSecret, encryptWorkspaceSecret } from '../../workspaces/secrets';
import {
  CodexRefreshError,
  OPENAI_AUTH_BASE,
  applyRefresh,
  buildRefreshBody,
  needsRefresh,
  parseCodexAuth,
  tokenStillValid,
  type CodexCredential,
  type StoredCodexAuth,
} from './codex-core';

export { CHATGPT_CODEX_BASE_URL, CODEX_USER_AGENT, CodexRefreshError } from './codex-core';
export type { CodexCredential } from './codex-core';

const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

interface SecretRow {
  secretId: string;
  ownerUserId: string | null;
  valueEnc: string;
}

async function loadCodexRow(workspaceId: string, userId: string): Promise<SecretRow | null> {
  const rows = await db
    .select({
      secretId: workspaceSecrets.secretId,
      ownerUserId: workspaceSecrets.ownerUserId,
      valueEnc: workspaceSecrets.valueEnc,
    })
    .from(workspaceSecrets)
    .where(and(
      eq(workspaceSecrets.workspaceId, workspaceId),
      eq(workspaceSecrets.name, CODEX_AUTH_JSON_SECRET_NAME),
      or(isNull(workspaceSecrets.ownerUserId), eq(workspaceSecrets.ownerUserId, userId)),
    ));
  if (!rows.length) return null;
  return rows.find((r) => r.ownerUserId === userId) ?? rows.find((r) => r.ownerUserId === null) ?? null;
}

const inflightRefresh = new Map<string, Promise<StoredCodexAuth | null>>();

async function refreshAndPersist(
  workspaceId: string,
  row: SecretRow,
  current: StoredCodexAuth,
  fetchImpl: FetchImpl,
): Promise<StoredCodexAuth | null> {
  if (!current.refresh) return null;

  let response: Response;
  try {
    response = await fetchImpl(`${OPENAI_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildRefreshBody(current.refresh),
    });
  } catch (err) {
    throw new CodexRefreshError(err instanceof Error ? err.message : 'network error');
  }
  if (!response.ok) throw new CodexRefreshError('upstream rejected refresh', response.status);

  const tokens = await response.json().catch(() => null);
  if (!tokens) throw new CodexRefreshError('refresh response was not valid json', response.status);

  const next = applyRefresh(tokens, current, Date.now());
  if (!next) throw new CodexRefreshError('refresh response missing access token', response.status);

  await db
    .update(workspaceSecrets)
    .set({ valueEnc: encryptWorkspaceSecret(workspaceId, JSON.stringify({ openai: next })), updatedAt: new Date() })
    .where(eq(workspaceSecrets.secretId, row.secretId));

  return next;
}

function refreshSingleFlight(
  workspaceId: string,
  row: SecretRow,
  current: StoredCodexAuth,
  fetchImpl: FetchImpl,
): Promise<StoredCodexAuth | null> {
  const existing = inflightRefresh.get(row.secretId);
  if (existing) return existing;
  const pending = refreshAndPersist(workspaceId, row, current, fetchImpl).finally(() => inflightRefresh.delete(row.secretId));
  inflightRefresh.set(row.secretId, pending);
  return pending;
}

export async function resolveCodexCredential(
  workspaceId: string,
  userId: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): Promise<CodexCredential | null> {
  const row = await loadCodexRow(workspaceId, userId);
  if (!row) return null;

  let stored = parseCodexAuth(decryptWorkspaceSecret(workspaceId, row.valueEnc));
  if (!stored?.access) return null;

  if (needsRefresh(stored, Date.now())) {
    try {
      const refreshed = await refreshSingleFlight(workspaceId, row, stored, fetchImpl);
      if (refreshed?.access) stored = refreshed;
    } catch (err) {
      // Grace period: a refresh blip shouldn't fail every Codex request. If the
      // current token is still within its validity window, keep using it; only
      // surface the error once it has genuinely expired.
      if (!tokenStillValid(stored, Date.now())) throw err;
    }
  }

  const access = stored.access;
  if (!access) return null;
  return { access, accountId: stored.accountId };
}
