import { isSessionVisibleTo, loadSessionGrants, resolveShareSubject, type SecretGrant, type ShareSubject } from '../../executor/share';
import { authorize, assertAuthorized } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { invalidateIamCacheForUser, registerPrincipalScopedMemo } from '../../iam/cache-invalidation';
import { auth } from '../../openapi';
import { preResumeRecentStoppedSessions } from '../routes/shared';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { resolveAccountId } from '../../shared/resolve-account';
import { getSupabase } from '../../shared/supabase';
import { ttlMemo } from '../../shared/ttl-memo';
import { effectiveWorkspaceRole, roleAllows, type AccountRole, type WorkspaceAccessAction, type WorkspaceRole } from '../access';
import { accountMembers, workspaceMembers, workspaceSessions, workspaces, serviceAccounts } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { FREE_TIER_WORKSPACE_LIMIT, maxWorkspacesForAccount } from '../../shared/account-limits';
import { getAccountMembership } from './git';
import { WorkspaceRow, WorkspaceSessionRow, normalizeString } from './serializers';
import { mergeSessionOwnerIdentities, type SessionOwnerIdentity } from './session-inventory';

// Enforce the per-account workspace cap (free → 3, paid → effectively uncapped).
// Returns a 403 Response to send, or null when the account may create another
// workspace. Every isolated workspace counts, even when another workspace uses the
// same Git repository or branch.
export async function enforceWorkspaceQuota(
  c: Context,
  accountId: string,
): Promise<Response | null> {
  const limit = await maxWorkspacesForAccount(accountId);
  if (limit >= Number.MAX_SAFE_INTEGER) return null;

  // Count only ACTIVE workspaces — an archived (soft-deleted) workspace must not
  // permanently consume a free account's single slot.
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaces)
    .where(and(eq(workspaces.accountId, accountId), eq(workspaces.status, 'active')));
  const count = counted?.count ?? 0;
  if (count >= limit) {
    return c.json(
      {
        error:
          limit === FREE_TIER_WORKSPACE_LIMIT
            ? `Free accounts are limited to ${limit} workspaces. Upgrade to a paid plan to create more.`
            : `This account has reached its limit of ${limit} workspaces.`,
        code: 'workspace_limit_reached',
        limit,
        count,
      },
      403,
    );
  }
  return null;
}

async function loadWorkspaceSessionRow(
  loaded: { row: WorkspaceRow },
  sessionId: string,
): Promise<WorkspaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(workspaceSessions)
    .where(and(
      eq(workspaceSessions.sessionId, sessionId),
      eq(workspaceSessions.workspaceId, loaded.row.workspaceId),
      eq(workspaceSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);
  return row ?? null;
}

export async function loadVisibleSession(
  loaded: { row: WorkspaceRow; userId: string; effectiveRole: WorkspaceRole; adminBypass?: boolean },
  sessionId: string,
): Promise<{
  row: WorkspaceSessionRow;
  subject: ShareSubject;
  grants: SecretGrant[];
  isOwner: boolean;
  canManageWorkspace: boolean;
  canManageSharing: boolean;
} | null> {
  const row = await loadWorkspaceSessionRow(loaded, sessionId);
  if (!row) return null;
  const subject = await resolveShareSubject(loaded.userId);
  const grants = (await loadSessionGrants([sessionId])).get(sessionId) ?? [];
  if (!isSessionVisibleTo(row.visibility as 'private' | 'workspace' | 'restricted', row.createdBy, grants, subject)) {
    // A platform-admin bypass already verified for the parent workspace (see
    // loadWorkspaceForUser) also covers a session that would otherwise be
    // invisible (private / not-my-grant). Audit every use — this is a real
    // support/investigation escape hatch, not a standing grant.
    if (!loaded.adminBypass) return null;
    await recordAuditEvent({
      accountId: loaded.row.accountId,
      actorUserId: loaded.userId,
      action: 'workspace.admin_bypass_session_read',
      resourceType: 'workspace_session',
      resourceId: sessionId,
      metadata: { via: 'admin_bypass_header', sessionVisibility: row.visibility },
    });
  }
  const isOwner = row.createdBy === loaded.userId;
  const canManageWorkspace = roleAllows(loaded.effectiveRole, 'manage');
  return { row, subject, grants, isOwner, canManageWorkspace, canManageSharing: isOwner || canManageWorkspace };
}

/**
 * Load a session for SHARING-MANAGEMENT purposes (the public-shares CRUD
 * routes) — a narrower, distinct question from `loadVisibleSession`'s "can
 * this user read the session's content/transcript".
 *
 * Managing a session's public share links is a workspace-management action:
 * the session's creator always can, and a workspace manager/owner/admin can
 * too, REGARDLESS of the session's private-content `visibility`. Reusing
 * `loadVisibleSession` here was a bug — a private session (the default)
 * is invisible to everyone but its creator under `isSessionVisibleTo`, so
 * the `canManageWorkspace` half of `canManageSharing` could never be reached:
 * the route always 404'd on the visibility gate first, even for a real
 * workspace manager. A workspace member with no manage rights (e.g. an editor
 * who didn't create the session) still gets a truthful 403 (permission
 * denied) here, not a 404 (resource hidden) — they're a legitimate member of
 * the workspace the session lives in, not a stranger, so there's nothing to
 * hide about the session's mere existence.
 */
export async function loadSessionForSharing(
  loaded: { row: WorkspaceRow; userId: string; effectiveRole: WorkspaceRole },
  sessionId: string,
): Promise<{
  row: WorkspaceSessionRow;
  isOwner: boolean;
  canManageWorkspace: boolean;
  canManageSharing: boolean;
} | null> {
  const row = await loadWorkspaceSessionRow(loaded, sessionId);
  if (!row) return null;
  const isOwner = row.createdBy === loaded.userId;
  const canManageWorkspace = roleAllows(loaded.effectiveRole, 'manage');
  return { row, isOwner, canManageWorkspace, canManageSharing: isOwner || canManageWorkspace };
}


// Memoized briefly (positive hits only) — same rationale and trade-off as
// getAccountMembership: runs on every workspace request, cross-region roundtrip
// per statement, revocations lag at most one TTL window, grants are instant.
const loadWorkspaceMemberRole = ttlMemo({
  ttlMs: 15_000,
  // Key is `${userId}|${workspaceId}` (userId-first) so a single
  // invalidateByPrefix(`${userId}|`) busts it alongside the engine memos.
  keyFn: (workspaceId: string, userId: string) => `${userId}|${workspaceId}`,
  loader: async (workspaceId: string, userId: string): Promise<WorkspaceRole | null> => {
    const [row] = await db
      .select({ workspaceRole: workspaceMembers.workspaceRole })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    return (row?.workspaceRole as WorkspaceRole | undefined) ?? null;
  },
  shouldCache: (role) => role !== null,
});
registerPrincipalScopedMemo(loadWorkspaceMemberRole);

export async function getWorkspaceMemberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  return loadWorkspaceMemberRole(workspaceId, userId);
}


export async function grantWorkspaceRole(input: {
  accountId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  grantedBy: string;
  /** undefined = leave as-is on update / NULL on insert; null = clear
   *  any existing expiry; Date = set/replace the expiry. */
  expiresAt?: Date | null | undefined;
}) {
  const now = new Date();
  await db
    .insert(workspaceMembers)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      workspaceRole: input.role,
      grantedBy: input.grantedBy,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: {
        workspaceRole: input.role,
        grantedBy: input.grantedBy,
        updatedAt: now,
        // Only overwrite expires_at when the caller explicitly supplied
        // it (undefined preserves the existing value).
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      },
    });
  // The role just changed — drop this user's cached authz so the new role is
  // effective on their next request, not after the ~15s TTL window.
  invalidateIamCacheForUser(input.userId);
}

/**
 * Parse + validate an optional `expires_at` ISO string from a request
 * body. undefined = caller didn't set; null = clear; Date = set.
 * Rejects past timestamps to surface mistakes at write time.
 */

export function parseExpiresAtBody(
  raw: unknown,
): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string')
    return { ok: false, error: 'expires_at must be an ISO-8601 string or null' };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    return { ok: false, error: 'expires_at must be a valid ISO-8601 timestamp' };
  if (d.getTime() < Date.now())
    return { ok: false, error: 'expires_at must be in the future' };
  return { ok: true, value: d };
}


export async function ensureOrgMembership(
  accountId: string,
  userId: string,
): Promise<AccountRole> {
  const existing = await getAccountMembership(userId, accountId);
  if (existing) return existing.accountRole as AccountRole;
  await db
    .insert(accountMembers)
    .values({ userId, accountId, accountRole: 'member' })
    .onConflictDoNothing();
  return 'member';
}

export interface UserIdentity {
  /** Email from the auth provider, or null if the user has none. */
  email: string | null;
  /** Best available display name from auth metadata. */
  displayName: string | null;
  /**
   * Whether this user_id resolves to a real auth user. `false` means the auth
   * provider returned NO user for this id — i.e. it's a shadow/orphan principal
   * (e.g. an `account_members` row whose user_id is actually an account_id with
   * no backing user). A transient lookup failure leaves this `true` so a hiccup
   * never hides a real member.
   */
  exists: boolean;
}

/**
 * Resolve user_ids to their auth identity (email + existence). Existence lets
 * callers drop "shadow" members — rows that point at a non-existent user, which
 * would otherwise render as a raw UUID in member lists.
 */
export async function resolveUserIdentities(userIds: string[]): Promise<Map<string, UserIdentity>> {
  const result = new Map<string, UserIdentity>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        // A completed call with no user object = the id is not a real user.
        const user = data?.user ?? null;
        const metadata = user?.user_metadata as Record<string, unknown> | undefined;
        const displayName =
          typeof metadata?.name === 'string'
            ? metadata.name
            : typeof metadata?.full_name === 'string'
              ? metadata.full_name
              : null;
        result.set(uid, { email: user?.email ?? null, displayName, exists: !!user });
      } catch {
        // Transient (network/5xx) — assume the user exists; don't hide them.
        result.set(uid, { email: null, displayName: null, exists: true });
      }
    }),
  );
  return result;
}

export async function resolveSessionOwnerIdentities(
  ownerIds: string[],
  accountId: string,
): Promise<Map<string, SessionOwnerIdentity>> {
  const uniqueOwnerIds = [...new Set(ownerIds)];
  if (uniqueOwnerIds.length === 0) return new Map();

  const users = await resolveUserIdentities(uniqueOwnerIds);
  const unresolvedIds = uniqueOwnerIds.filter((ownerId) => !users.get(ownerId)?.exists);
  const machineIdentities = unresolvedIds.length
    ? await db
        .select({
          serviceAccountId: serviceAccounts.serviceAccountId,
          name: serviceAccounts.name,
          agentName: serviceAccounts.agentName,
        })
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.accountId, accountId),
            inArray(serviceAccounts.serviceAccountId, unresolvedIds),
          ),
        )
    : [];

  return mergeSessionOwnerIdentities({
    ownerIds: uniqueOwnerIds,
    users,
    serviceAccounts: machineIdentities,
  });
}

export async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const identities = await resolveUserIdentities(userIds);
  const result = new Map<string, string | null>();
  for (const [uid, identity] of identities) result.set(uid, identity.email);
  return result;
}


export async function resolveWorkspaceAccount(c: Context, body?: Record<string, unknown>) {
  const userId = c.get('userId') as string;
  const requested = normalizeString(
    c.req.query('account_id') ??
    c.req.query('accountId') ??
    body?.account_id ??
    body?.accountId,
  );
  const accountId = requested ?? await resolveAccountId(userId);

  const membership = await getAccountMembership(userId, accountId);
  if (!membership) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }
  (c as any).set('accountId', membership.accountId);

  return {
    userId,
    accountId: membership.accountId,
    accountRole: membership.accountRole as AccountRole,
  };
}

// Maps the high-level workspace access action onto the IAM action key
// the engine recognises. Keep this narrow — these three labels cover
// every gate this file uses; bespoke actions (workspace.trigger.fire,
// workspace.trigger.create, workspace.secret.write, etc.) should call authorize()
// directly with the exact action.

export function iamActionForWorkspaceAccess(action: WorkspaceAccessAction): string {
  switch (action) {
    case 'read':
      return 'workspace.read';
    case 'session':
      // Starting / running / stopping a session. Granted to every workspace
      // role (a plain `member` included) so the floor role can actually use
      // Kortix, while workspace customization stays behind workspace.write.
      return 'workspace.session.start';
    case 'write':
      return 'workspace.write';
    case 'manage':
      // 'manage' historically meant "admin-tier write" — covers triggers,
      // secrets, snapshots, CLI tokens, etc. Map to workspace.write (which
      // Workspace Editor has) so editors aren't accidentally locked out.
      // Routes that need the stricter `workspace.members.manage` gate add
      // an explicit assertWorkspaceCapability() on top of loadWorkspaceForUser.
      return 'workspace.write';
  }
}

/**
 * Assert a SPECIFIC workspace capability (a leaf action like workspace.gitops.push)
 * for the current request, threading the acting token id off the request context
 * so the engine's agent-grant fold actually fires — `userRole ∩ agentGrant`. Use
 * this (not a bare `assertAuthorized`) for every per-capability route gate: a
 * bare call omits the token and the fold silently no-ops, which is exactly how
 * the per-route checks leaked the agent grant. 403s on denial.
 */
export async function assertWorkspaceCapability(
  c: Context,
  userId: string,
  accountId: string,
  workspaceId: string,
  action: string,
  // Optional per-RESOURCE narrowing: when supplied, the verdict is additionally
  // intersected with iam_resource_grants for this specific agent/skill (see
  // resource-grants.ts). Used by the agent/skill launch gates.
  resource?: { type: 'agent' | 'skill'; id: string },
): Promise<void> {
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as string | undefined) ?? undefined;
  await assertAuthorized(
    userId,
    accountId,
    action,
    { type: 'workspace', id: workspaceId, ...(resource ? { resource } : {}) },
    actingTokenId,
    deriveRequestContext(c),
  );
}

/**
 * Non-throwing sibling of assertWorkspaceCapability: returns WHETHER the leaf is
 * allowed for the current request (threading the acting token so the agent-grant
 * fold fires), instead of 403-ing. For response-level filtering where a coarse
 * gate already passed but individual sections must be hidden per-capability —
 * e.g. GET /detail returns the workspace shell to any member but omits the file
 * list / a config sub-section the caller can't read, rather than denying the
 * whole bundle (which would lock a plain `member`, who lacks file.read, out of
 * the workspace entirely).
 */
export async function workspaceCapabilityAllowed(
  c: Context,
  userId: string,
  accountId: string,
  workspaceId: string,
  action: string,
): Promise<boolean> {
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as string | undefined) ?? undefined;
  const verdict = await authorize(
    userId,
    accountId,
    action,
    { type: 'workspace', id: workspaceId },
    actingTokenId,
    deriveRequestContext(c),
  );
  return verdict.allowed;
}

// `workspaces.workspace_id` is a Postgres `uuid` column, so a malformed id
// (e.g. a truncated "fda4e35e") makes the lookup throw `invalid input syntax
// for type uuid` (SQLSTATE 22P02) before any guard runs — surfacing as an
// opaque 500. Validate the shape first so a bad id is a clean 404, not a 500.
const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return WORKSPACE_ID_RE.test(value);
}

/**
 * The full platform-admin-bypass decision — pure (the DB/header lookups are
 * already resolved into `isPlatformAdmin`/`bypassHeaderPresent` by the
 * caller) so this security gate is exhaustively unit-tested independent of
 * the DB, mirroring the decideReap pattern in sandbox-reaper.ts. A bypass is
 * never eligible for anything but a read, and never for a service account
 * (those already carry their own iam_policies and shouldn't get a second,
 * broader door) — checked BEFORE `isPlatformAdmin` is even consulted by the
 * caller, so a non-admin's header never triggers a DB round-trip.
 */
export function shouldApplyAdminBypass(input: {
  action: WorkspaceAccessAction;
  isServiceAccount: boolean;
  bypassHeaderPresent: boolean;
  isPlatformAdmin: boolean;
}): boolean {
  return (
    isAdminBypassEligible(input) && input.isPlatformAdmin
  );
}

/** Whether a bypass request should even be CONSIDERED — i.e. whether it's
 *  worth spending a DB round-trip on `isPlatformAdmin` at all. */
export function isAdminBypassEligible(input: {
  action: WorkspaceAccessAction;
  isServiceAccount: boolean;
  bypassHeaderPresent: boolean;
}): boolean {
  return input.action === 'read' && !input.isServiceAccount && input.bypassHeaderPresent;
}

export async function loadWorkspaceForUser(c: Context, workspaceId: string, action: WorkspaceAccessAction) {
  const userId = c.get('userId') as string;
  if (!isUuid(workspaceId)) return null;
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.workspaceId, workspaceId))
    .limit(1);
  if (!row || row.status === 'archived') return null;

  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;
  const requestCtx = deriveRequestContext(c);

  // Membership, workspace role and the IAM verdict are independent lookups —
  // overlap them. Every workspace-scoped request runs this path and each DB
  // statement costs a cross-region roundtrip in prod, so depth matters.
  // The engine consults super-admin bypass, direct + group policies,
  // workspace_groups, AND the legacy account_role / workspace_members bridges
  // (in non-strict mode), so it's strictly a superset of the old role-only
  // check. Passing requestCtx is required for IP-allowlist / require-MFA
  // policy conditions to evaluate against the current request.
  const [membership, workspaceRole, verdict] = await Promise.all([
    getAccountMembership(userId, row.accountId),
    getWorkspaceMemberRole(workspaceId, userId),
    authorize(
      userId,
      row.accountId,
      iamActionForWorkspaceAccess(action),
      { type: 'workspace', id: workspaceId },
      actingTokenId,
      requestCtx,
    ),
  ]);

  // A service account has NO account_members row — its access is purely its own
  // iam_policies, already evaluated by the engine `verdict` above. Don't apply
  // the human membership hard-gate to it (that would 403 every SA before its
  // standing role is ever consulted); fall through to the verdict check.
  const isServiceAccount = ((c as unknown as { get(k: string): unknown }).get('authType') as string | undefined) === 'service_account';

  // Platform-admin READ-ONLY bypass: an explicit `x-kortix-admin-bypass`
  // header from a real `platform_user_roles` admin/super_admin lets support
  // staff VIEW a workspace they have no account/workspace grant on — e.g. to
  // confirm a customer's session actually loads. Deliberately scoped to
  // action === 'read' only (never write/session/manage) so a bypass can
  // never be used to act as the account. Every use is audit-logged against
  // the WORKSPACE'S OWN account so the customer's own audit trail (and any
  // configured audit webhook) sees the access, not just ours.
  let adminBypass = false;
  const bypassHeaderPresent = c.req.header('x-kortix-admin-bypass') === '1';
  if (isAdminBypassEligible({ action, isServiceAccount, bypassHeaderPresent })) {
    adminBypass = shouldApplyAdminBypass({
      action,
      isServiceAccount,
      bypassHeaderPresent,
      isPlatformAdmin: await isPlatformAdmin(userId),
    });
    if (adminBypass) {
      await recordAuditEvent({
        accountId: row.accountId,
        actorUserId: userId,
        action: 'workspace.admin_bypass_read',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { via: 'admin_bypass_header' },
      });
    }
  }

  if (!membership && !isServiceAccount && !adminBypass) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }

  const accountRole = membership?.accountRole as AccountRole | undefined;
  if (!verdict.allowed && !adminBypass) {
    // Distinguish "no access at all" from "has access but not for this
    // action" so the UI can show a meaningful message. A Viewer can see
    // the workspace but can't create a session — telling them "no access"
    // is misleading and they spend time wondering why they can see the
    // page at all. Only do the second probe when the failed action was
    // NOT already 'read' — otherwise it's the same answer.
    if (action !== 'read') {
      const readVerdict = await authorize(
        userId,
        row.accountId,
        'workspace.read',
        { type: 'workspace', id: workspaceId },
        actingTokenId,
        requestCtx,
      );
      if (readVerdict.allowed) {
        const verb = action === 'manage' ? 'manage this workspace' : 'change this workspace';
        throw new HTTPException(403, {
          message: `Your role on this workspace doesn't let you ${verb}. Ask an account owner or admin to grant you a higher role.`,
        });
      }
    }
    throw new HTTPException(403, { message: 'You do not have access to this workspace' });
  }

  // effectiveRole label for the UI / downstream helpers. The engine
  // doesn't hand back a role — it answers yes/no. Mirror the prior
  // mapping so any code reading effectiveRole still gets sensible
  // labels: owner/admin → manager, explicit workspace_members row →
  // that role, otherwise → 'member' (the engine permitted read but
  // we don't know the exact tier).
  // For a service account there's no account role; capabilities come purely from
  // its policies (already enforced by `verdict`). Use the safe-minimum 'member'
  // label, exactly as for a member granted access via a policy with no role tier.
  const effectiveRole =
    (accountRole ? effectiveWorkspaceRole(accountRole, workspaceRole) : workspaceRole) ?? 'member';
  (c as any).set('accountId', row.accountId);

  if (action !== 'read' || roleAllows(effectiveRole as WorkspaceRole, 'write')) {
    // Proactively wake the user's most recently-stopped session(s) so the resume
    // overlaps their navigation. No-op unless KORTIX_PRERESUME_ENABLED.
    preResumeRecentStoppedSessions(workspaceId, userId);
  }

  return {
    row,
    userId,
    accountRole: accountRole ?? null,
    workspaceRole,
    effectiveRole: effectiveRole as WorkspaceRole,
    adminBypass,
  };
}

// Env names a workspace secret must NEVER inject into a sandbox — they belong to
// the sandbox's own runtime (the OS, the daemon, opencode). A secret named e.g.
// `PORT` (trivially pushed via `kortix env push --from a-server.env`) would
// override the runtime and break every session. Anything `KORTIX_*`/`OPENCODE_*`
// is platform-owned and set explicitly below.
