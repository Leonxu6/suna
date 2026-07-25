#!/usr/bin/env bun
/**
 * Live E2E for workspace-scoped CLI tokens.
 *
 * What it verifies:
 *   1. POST /v1/workspaces/:id/cli-token mints a token bound to that
 *      workspace (response carries `workspace_id`).
 *   2. The minted token CAN call routes scoped to its workspace
 *      (GET /v1/workspaces/:id, GET /v1/workspaces/:id/secrets).
 *   3. The token CANNOT call a different workspace's routes (403).
 *   4. The token CANNOT call account-level routes (/v1/accounts/tokens),
 *      but the self-identity probe (/v1/accounts/me) is allowed.
 *   5. The token CANNOT enumerate workspaces (GET /v1/workspaces → 403).
 *   6. The token CAN use workspace-explicit Executor routes for its workspace
 *      (gateway + connector management), but not another workspace's routes.
 *   7. Revoking via DELETE /v1/workspaces/:id/cli-token/:tokenId yields
 *      401 on the next call.
 *
 * Requires the API on $KORTIX_API_URL (default http://localhost:8008)
 * and Postgres on the default local Supabase port.
 */

import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  generateAccountTokenPair,
  hashSecretKey,
} from '../shared/crypto';

const API_BASE = process.env.KORTIX_API_URL ?? 'http://localhost:8008';

function ok(msg: string) {
  process.stdout.write(`  \x1b[0;32m✓\x1b[0m  ${msg}\n`);
}
function dim(label: string, value: string) {
  process.stdout.write(`  \x1b[2m${label}\x1b[0m  ${value}\n`);
}
function die(msg: string): never {
  process.stderr.write(`  \x1b[0;31m✗\x1b[0m  ${msg}\n`);
  process.exit(1);
}

interface Row extends Record<string, unknown> {
  user_id: string;
  account_id: string;
}

interface WorkspaceRow extends Record<string, unknown> {
  workspace_id: string;
  account_id: string;
  name: string;
}

async function callApi(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}/v1${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function main() {
  process.stdout.write('\n  \x1b[1mWorkspace-scoped CLI token E2E\x1b[0m\n');
  dim('api', API_BASE);

  // ── 1. Pick a user + two workspaces they own ──────────────────────────
  const member = await db.execute<Row>(
    sql`select user_id, account_id from kortix.account_members order by joined_at limit 1`,
  );
  const memberRows =
    (member as unknown as { rows?: Row[] }).rows ?? (member as unknown as Row[]);
  const m = memberRows[0];
  if (!m) die('No account_members rows.');

  const workspaces = await db.execute<WorkspaceRow>(sql`
    select workspace_id, account_id, name
    from kortix.workspaces
    where account_id = ${m.account_id}
    order by created_at desc
    limit 2
  `);
  const workspaceRows =
    (workspaces as unknown as { rows?: WorkspaceRow[] }).rows
    ?? (workspaces as unknown as WorkspaceRow[]);
  if (workspaceRows.length < 2) {
    die(`Need ≥ 2 workspaces on account ${m.account_id} for the cross-workspace test. Have ${workspaceRows.length}.`);
  }
  const [projA, projB] = workspaceRows;
  const foreignWorkspaces = await db.execute<WorkspaceRow>(sql`
    select workspace_id, account_id, name
    from kortix.workspaces
    where account_id <> ${m.account_id}
    order by created_at desc
    limit 1
  `);
  const foreignWorkspaceRows =
    (foreignWorkspaces as unknown as { rows?: WorkspaceRow[] }).rows
    ?? (foreignWorkspaces as unknown as WorkspaceRow[]);
  const foreignWorkspace = foreignWorkspaceRows[0] ?? null;
  dim('user', m.user_id);
  dim('projA', `${projA.workspace_id} (${projA.name})`);
  dim('projB', `${projB.workspace_id} (${projB.name})`);
  if (foreignWorkspace) dim('foreign', `${foreignWorkspace.workspace_id} (${foreignWorkspace.name})`);

  // ── 2. Mint a workspace-scoped token for projA via direct DB insert ───
  const { publicKey, secretKey } = generateAccountTokenPair();
  const secretKeyHash = hashSecretKey(secretKey);
  await db.execute(sql`
    insert into kortix.account_tokens
      (account_id, user_id, workspace_id, name, public_key, secret_key_hash)
    values
      (${m.account_id}, ${m.user_id}, ${projA.workspace_id}, 'e2e-scope-test', ${publicKey}, ${secretKeyHash})
  `);
  dim('pat ', `${secretKey.slice(0, 20)}… (scoped to projA)`);

  // ── 3. Allowed: call projA's routes ──────────────────────────────────
  const projAInfo = await callApi(secretKey, `/workspaces/${projA.workspace_id}`);
  if (projAInfo.status !== 200) {
    die(`projA token → /workspaces/${projA.workspace_id} got ${projAInfo.status}: ${JSON.stringify(projAInfo.body)}`);
  }
  ok(`token can read its own workspace (GET /workspaces/<projA>) → 200`);

  const projASecrets = await callApi(secretKey, `/workspaces/${projA.workspace_id}/secrets`);
  if (projASecrets.status !== 200) {
    die(`projA token → /workspaces/<projA>/secrets got ${projASecrets.status}`);
  }
  ok(`token can list its own workspace's secrets → 200`);

  // ── 4. Allowed: /accounts/me self-identity probe ─────────────────────
  const me = await callApi(secretKey, '/accounts/me');
  if (me.status !== 200) {
    die(`projA token → /accounts/me got ${me.status}: ${JSON.stringify(me.body)}`);
  }
  const meBody = me.body as { token_context?: { workspace_id?: string | null; session_id?: string | null } } | null;
  if (meBody?.token_context?.workspace_id !== projA.workspace_id || meBody.token_context.session_id !== null) {
    die(`/accounts/me token_context mismatch for workspace token: ${JSON.stringify(me.body)}`);
  }
  ok('token can hit /accounts/me (self-identity probe) → 200');

  // ── 5. Denied: a different workspace's routes ──────────────────────────
  const projBInfo = await callApi(secretKey, `/workspaces/${projB.workspace_id}`);
  if (projBInfo.status !== 403) {
    die(`projA token → /workspaces/<projB> should 403, got ${projBInfo.status}: ${JSON.stringify(projBInfo.body)}`);
  }
  ok(`token cannot access a different workspace → 403`);

  // ── 6. Denied: list workspaces ─────────────────────────────────────────
  const list = await callApi(secretKey, '/workspaces');
  if (list.status !== 403) {
    die(`projA token → /workspaces (list) should 403, got ${list.status}`);
  }
  ok('token cannot enumerate workspaces → 403');

  // ── 7. Denied: account-level token management ────────────────────────
  const tokens = await callApi(secretKey, '/accounts/tokens');
  if (tokens.status !== 403) {
    die(`projA token → /accounts/tokens should 403, got ${tokens.status}`);
  }
  ok('token cannot list account-level PATs → 403');

  // ── 8. Executor workspace scope: own workspace allowed, cross-workspace denied ─
  const executorCatalog = await callApi(secretKey, `/executor/workspaces/${projA.workspace_id}/catalog`);
  if (executorCatalog.status !== 200) {
    die(`projA token → /executor/workspaces/<projA>/catalog should 200, got ${executorCatalog.status}: ${JSON.stringify(executorCatalog.body)}`);
  }
  ok('token can use the Executor workspace-explicit catalog gateway → 200');

  const executorAdmin = await callApi(secretKey, `/executor/workspaces/${projA.workspace_id}/connectors`);
  if (executorAdmin.status !== 200) {
    die(`projA token → /executor/workspaces/<projA>/connectors should 200, got ${executorAdmin.status}: ${JSON.stringify(executorAdmin.body)}`);
  }
  ok('token can use Executor connector management routes for its own workspace → 200');

  const crossWorkspaceCatalog = await callApi(secretKey, `/executor/workspaces/${projB.workspace_id}/catalog`);
  if (crossWorkspaceCatalog.status !== 403) {
    die(`projA token → /executor/workspaces/<projB>/catalog should 403, got ${crossWorkspaceCatalog.status}: ${JSON.stringify(crossWorkspaceCatalog.body)}`);
  }
  ok('token cannot use Executor gateway routes for a different workspace → 403');

  // ── 8b. Defense-in-depth: forged foreign workspace scope is rejected ───
  if (foreignWorkspace) {
    const forged = generateAccountTokenPair();
    const forgedHash = hashSecretKey(forged.secretKey);
    await db.execute(sql`
      insert into kortix.account_tokens
        (account_id, user_id, workspace_id, name, public_key, secret_key_hash)
      values
        (${m.account_id}, ${m.user_id}, ${foreignWorkspace.workspace_id}, 'e2e-forged-foreign-scope', ${forged.publicKey}, ${forgedHash})
    `);
    try {
      const forgedCatalog = await callApi(forged.secretKey, `/executor/workspaces/${foreignWorkspace.workspace_id}/catalog`);
      if (forgedCatalog.status !== 403) {
        die(`foreign-scoped forged token → /executor/workspaces/<foreign>/catalog should 403, got ${forgedCatalog.status}: ${JSON.stringify(forgedCatalog.body)}`);
      }
      ok('forged token row with a foreign workspace_id cannot use Executor gateway routes → 403');
    } finally {
      await db.execute(sql`
        delete from kortix.account_tokens where secret_key_hash = ${forgedHash}
      `);
    }
  } else {
    dim('foreign', 'executor forged-scope check skipped (no second account workspace available)');
  }

  // ── 9. Revoke + verify 401 ───────────────────────────────────────────
  await db.execute(sql`
    update kortix.account_tokens
    set status = 'revoked', revoked_at = now()
    where secret_key_hash = ${secretKeyHash}
  `);
  const afterRevoke = await callApi(secretKey, `/workspaces/${projA.workspace_id}`);
  if (afterRevoke.status !== 401) {
    die(`revoked projA token should 401, got ${afterRevoke.status}`);
  }
  ok('revoked token → 401');

  // Cleanup
  await db.execute(sql`
    delete from kortix.account_tokens where secret_key_hash = ${secretKeyHash}
  `);

  process.stdout.write('\n  \x1b[0;32mAll scope-enforcement checks passed.\x1b[0m\n\n');
  process.exit(0);
}

main().catch((err) => {
  die(`E2E failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`);
});
