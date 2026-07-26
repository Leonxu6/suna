// IAM V2 engine. The only authorization path — the V1 policy engine and
// its accounts.iam_v2_enabled rollout flag were retired in PR5.
//
// Decides access from the built-in role tables…
//   - account_members         (account_role, is_super_admin)
//   - workspace_members         (direct per-user workspace_role)
//   - workspace_group_grants    (group → workspace → workspace_role, expanded
//                               via account_group_members)
// …UNIONED (allow-only, highest-wins) with DB-driven custom roles (IAM v1):
//   - iam_policies + iam_role_actions  (member/group principal → custom role's
//                                        action set, at account or workspace scope)
//
// No deny precedence, no conditions. The built-in role is the fast path; a
// custom policy can only ADD actions, never remove — so built-in roles behave
// exactly as before and the union is inert until an admin creates a custom role.
//
// The pure-function helpers (deriveEffectiveWorkspaceRole, scopeForActionV2,
// customPolicyAllows) are exported so they can be unit-tested without a DB.

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accountTokens,
  accounts,
  iamPolicies,
  iamRoleActions,
  workspaceGroupGrants,
  workspaceMembers,
  workspaces,
  serviceAccounts,
  type AgentGrant,
} from '@kortix/db';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';
import { agentMayPerform } from './agent-scope';
import { registerPrincipalScopedMemo } from './cache-invalidation';
import {
  filterAccessibleResourceIds,
  isResourceAccessible,
  loadWorkspaceResourceGrants,
} from './resource-grants';
import type {
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './engine';
import {
  accountRoleAllows,
  implicitWorkspaceRoleForAccount,
  maxWorkspaceRole,
  normalizeWorkspaceRole,
  workspaceRoleAllows,
  type AccountRole,
  type WorkspaceRole,
} from './role-perms';

// ─── Pure helpers (exported for unit tests) ────────────────────────────────

type ActionScopeV2 = 'account' | 'workspace';

/**
 * V2 scope detection. V2 collapses sandbox/trigger/channel into the
 * workspace they belong to — callers always pass a workspace target for
 * those actions. account.*, billing.*, audit.*, member.*, group.*,
 * role.*, policy.*, token.* and workspace.create are account-level;
 * everything else is workspace-level.
 */
export function scopeForActionV2(action: string): ActionScopeV2 {
  if (action === 'workspace.create') return 'account';
  if (
    action.startsWith('account.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.')
  ) {
    return 'account';
  }
  return 'workspace';
}

/**
 * Combine the three possible sources of a user's workspace role into one
 * effective role. Returns null when the user has no path to the workspace.
 *
 *   accountRole = 'owner' | 'admin' | 'member'
 *   directRole  = workspace_members.workspace_role (or null when no direct row)
 *   groupRoles  = [] of workspace_group_grants.role rows for groups the user is in
 */
export function deriveEffectiveWorkspaceRole(
  accountRole: AccountRole,
  directRole: WorkspaceRole | null,
  groupRoles: readonly WorkspaceRole[],
): WorkspaceRole | null {
  // Owner/admin: implicit Manager on every workspace in the account. Group
  // and direct rows can't elevate further; nothing can demote below this.
  const implicit = implicitWorkspaceRoleForAccount(accountRole);
  let best: WorkspaceRole | null = implicit;

  if (directRole) {
    best = best ? maxWorkspaceRole(best, directRole) : directRole;
  }
  for (const r of groupRoles) {
    best = best ? maxWorkspaceRole(best, r) : r;
  }
  return best;
}

// ─── DB lookups ────────────────────────────────────────────────────────────
//
// LATENCY NOTE (prod incident, 2026-06-12; measurement corrected 2026-07-26):
// every DB statement from the prod fleet is a fast same-region roundtrip
// (~3ms measured — DB and API both sit in eu-west-2, not the cross-region
// cost originally assumed here), and these principal lookups run on every
// single authed request — often 10+ times in parallel during one page load.
// Two levers keep that off the floor of every request:
//   1. Independent queries run via Promise.all (depth, not count, costs time).
//   2. Results are memoized for a short TTL (IAM_CACHE_TTL_MS, default 15s) —
//      *positive* results only, so a freshly granted member sees access
//      immediately while a revoked one keeps it for at most one TTL window.

const IAM_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

/** A custom-role action this actor holds, with the scope it applies at.
 *  scopeType 'account' grants everywhere; 'workspace' grants only on scopeId. */
export type CustomAction = { scopeType: string; scopeId: string | null; action: string };

type ResolvedActorV2 = {
  /** 'member' = a human (account_members row). 'service_account' = a machine
   *  identity (service_accounts row) whose ONLY authority is its own iam_policies
   *  (principal_type='token') — no built-in role, no membership baseline. */
  kind: 'member' | 'service_account';
  /** For a service account: does it have ANY policy binding (even to a
   *  zero-action role)? This is the standing-identity activation signal — an
   *  admin "activates" an agent by binding it to a role. Distinct from
   *  customActions (empty both for "unbound" AND "bound to an empty role"), so
   *  an admin CAN pin an agent to deny-by-default by binding a minimal role.
   *  Always false for members (they don't use this path). */
  activated: boolean;
  isSuperAdmin: boolean;
  accountRole: AccountRole | null;
  groupIds: string[];
  accountMfaRequired: boolean;
  /** Actions granted by DB custom roles via iam_policies (member + group
   *  principals for a human; the token principal for a service account). Empty
   *  for the common no-custom-roles account. */
  customActions: CustomAction[];
};

async function resolveActorV2Uncached(
  userId: string,
  accountId: string,
): Promise<ResolvedActorV2 | null> {
  // The custom-policy query is self-contained (group membership via a subquery)
  // so all three run in ONE parallel batch — no added latency depth. It returns
  // [] for the overwhelmingly common account with no custom roles.
  const [memberRows, groups, policyRows] = await Promise.all([
    db
      .select({
        isSuperAdmin: accountMembers.isSuperAdmin,
        accountRole: accountMembers.accountRole,
        mfaRequired: accounts.mfaRequired,
      })
      .from(accountMembers)
      .innerJoin(accounts, eq(accounts.accountId, accountMembers.accountId))
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
      .limit(1),
    db
      .select({ groupId: accountGroupMembers.groupId })
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.userId, userId)),
    db
      .select({
        scopeType: iamPolicies.scopeType,
        scopeId: iamPolicies.scopeId,
        action: iamRoleActions.action,
      })
      .from(iamPolicies)
      .innerJoin(iamRoleActions, eq(iamRoleActions.roleId, iamPolicies.roleId))
      .where(
        and(
          eq(iamPolicies.accountId, accountId),
          or(isNull(iamPolicies.expiresAt), gt(iamPolicies.expiresAt, sql`now()`)),
          or(
            and(eq(iamPolicies.principalType, 'member'), eq(iamPolicies.principalId, userId)),
            and(
              eq(iamPolicies.principalType, 'group'),
              inArray(
                iamPolicies.principalId,
                db
                  .select({ gid: accountGroupMembers.groupId })
                  .from(accountGroupMembers)
                  .where(eq(accountGroupMembers.userId, userId)),
              ),
            ),
            // Service-account principal: a token policy keyed on this id. Harmless
            // for a human request (SA ids and user ids are disjoint uuids, so this
            // matches nothing), load-bearing for an SA request (its standing role).
            and(eq(iamPolicies.principalType, 'token'), eq(iamPolicies.principalId, userId)),
          ),
        ),
      ),
  ]);
  const customActions: CustomAction[] = policyRows.map((r) => ({
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    action: r.action,
  }));

  const member = memberRows[0];
  if (member) {
    return {
      kind: 'member',
      activated: false, // n/a for members
      isSuperAdmin: member.isSuperAdmin,
      accountRole: (member.accountRole as AccountRole | null) ?? null,
      groupIds: groups.map((g) => g.groupId),
      accountMfaRequired: member.mfaRequired,
      customActions,
    };
  }

  // Not a human member — is this id a service account in this account? (Rare
  // path: only SA-authenticated requests and genuinely-unknown ids reach here,
  // so the extra query never touches the hot human/PAT path.) A service account
  // has NO membership baseline and NO built-in role: its entire authority is its
  // own iam_policies (principal_type='token'), already loaded into customActions.
  const saRows = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.serviceAccountId, userId),
        eq(serviceAccounts.accountId, accountId),
        eq(serviceAccounts.status, 'active'),
      ),
    )
    .limit(1);
  if (saRows[0]) {
    // Activation = the SA has ANY policy binding (even to a zero-action role).
    // This is what lets the agent-session opt-in switch flip ON, and lets an
    // admin pin an agent to deny-by-default (bind a minimal role) vs. leaving it
    // unmanaged (no binding → the session falls back to the launching user).
    const bindingRows = await db
      .select({ id: iamPolicies.policyId })
      .from(iamPolicies)
      .where(
        and(
          eq(iamPolicies.principalType, 'token'),
          eq(iamPolicies.principalId, userId),
          eq(iamPolicies.accountId, accountId),
          // Respect expiry, same as the customActions query — otherwise an
          // EXPIRED-only binding reads as activated:true with empty actions =
          // permanent deny-all (bricked agent). With this, an expired/removed
          // binding → activated:false → the session reverts to the baseline
          // (launching user ∩ grant), the pre-standing-identity containment. To
          // LOCK an agent down, bind it a live restrictive role (activated, but
          // its omitted leaves deny); removing the binding un-manages it.
          or(isNull(iamPolicies.expiresAt), gt(iamPolicies.expiresAt, sql`now()`)),
        ),
      )
      .limit(1);
    return {
      kind: 'service_account',
      activated: bindingRows.length > 0,
      isSuperAdmin: false,
      accountRole: null,
      groupIds: [],
      accountMfaRequired: false,
      customActions,
    };
  }

  return null;
}

/**
 * Does a DB custom policy grant `action` at this scope? Allow-only union with
 * the built-in role: an account-scoped policy grants the action everywhere; a
 * workspace-scoped policy grants it only on its own workspace. Pure (exported for
 * unit tests) — operates on the actor's resolved customActions.
 */
export function customPolicyAllows(
  customActions: CustomAction[],
  scope: ActionScopeV2,
  action: string,
  target: AuthorizeTarget,
): boolean {
  if (customActions.length === 0) return false;
  for (const ca of customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return true;
    if (scope === 'workspace' && target.type === 'workspace' && ca.scopeType === 'workspace' && ca.scopeId === target.id) {
      return true;
    }
  }
  return false;
}

const resolveActorV2 = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (userId: string, accountId: string) => `${userId}|${accountId}`,
  loader: resolveActorV2Uncached,
  shouldCache: (actor) => actor !== null,
});
// Key is `${userId}|…` → bust per principal on account-member / group-membership
// changes (see cache-invalidation.ts).
registerPrincipalScopedMemo(resolveActorV2);

/**
 * Look up the actor's effective role on a specific workspace. Combines
 * the direct workspace_members row (if any) with every workspace_group_grants
 * row for any group the user belongs to. Returns null when there's no
 * path at all and the actor isn't an account admin/owner.
 */
// Time-bounded grants: a row whose expires_at is in the past is
// effectively gone. Filter at the SQL layer so the row is invisible
// to every authorize() call the moment the clock crosses the line —
// no waiting on the sweeper. (The sweeper just emits the audit
// event afterwards; correctness doesn't depend on it.)
const loadWorkspaceRoleRows = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (userId: string, workspaceId: string, groupIds: string[]) =>
    `${userId}|${workspaceId}|${groupIds.join(',')}`,
  loader: async (userId: string, workspaceId: string, groupIds: string[]) => {
    const [directRows, grantRows] = await Promise.all([
      db
        .select({ role: workspaceMembers.workspaceRole })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
            or(
              isNull(workspaceMembers.expiresAt),
              gt(workspaceMembers.expiresAt, sql`now()`),
            ),
          ),
        )
        .limit(1),
      groupIds.length > 0
        ? db
            .select({ role: workspaceGroupGrants.role })
            .from(workspaceGroupGrants)
            .where(
              and(
                eq(workspaceGroupGrants.workspaceId, workspaceId),
                inArray(workspaceGroupGrants.groupId, groupIds),
                or(
                  isNull(workspaceGroupGrants.expiresAt),
                  gt(workspaceGroupGrants.expiresAt, sql`now()`),
                ),
              ),
            )
        : Promise.resolve([] as Array<{ role: string }>),
    ]);
    return {
      // Normalize at the DB-read boundary so a legacy `viewer` row resolves
      // to `user` (the tier it was folded into) rather than an unknown role.
      directRole: normalizeWorkspaceRole(directRows[0]?.role),
      groupRoles: grantRows.flatMap((r) => {
        const role = normalizeWorkspaceRole(r.role);
        return role ? [role] : [];
      }),
    };
  },
  // Never cache "no path to this workspace" — a freshly granted member must
  // see access on their next request, not after a TTL window.
  shouldCache: (v) => v.directRole !== null || v.groupRoles.length > 0,
});
// Key is `${userId}|${workspaceId}|…` → bust per principal on workspace-member /
// workspace-group-grant changes.
registerPrincipalScopedMemo(loadWorkspaceRoleRows);

async function loadEffectiveWorkspaceRole(
  actor: ResolvedActorV2,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const accountRole = actor.accountRole ?? 'member';

  // Owner/admin carry implicit Manager — the per-workspace rows can only tie,
  // never exceed it (manager is the top rank), so skip the lookups entirely.
  if (implicitWorkspaceRoleForAccount(accountRole)) return 'manager';

  const rows = await loadWorkspaceRoleRows(userId, workspaceId, actor.groupIds);
  return deriveEffectiveWorkspaceRole(accountRole, rows.directRole, rows.groupRoles);
}

/**
 * PAT scope check. A PAT bound to a specific workspace (account_tokens.workspace_id
 * set) is refused on any request whose target is a different workspace, or
 * on account-level requests entirely. Returns true when the PAT is in
 * scope for this request, false when it should be denied.
 */
// A token's workspace binding is immutable after mint, so caching it is safe;
// "token row missing" is never cached (a just-minted token must work, and
// revocation is enforced upstream by validateAccountToken at auth time).
const loadTokenWorkspaceBinding = ttlMemo({
  ttlMs: IAM_CACHE_TTL_MS,
  keyFn: (tokenId: string) => tokenId,
  loader: async (
    tokenId: string,
  ): Promise<{ workspaceId: string | null; agentGrant: AgentGrant | null; serviceAccountId: string | null } | null> => {
    const [row] = await db
      .select({
        workspaceId: accountTokens.workspaceId,
        agentGrant: accountTokens.agentGrant,
        serviceAccountId: accountTokens.serviceAccountId,
      })
      .from(accountTokens)
      .where(eq(accountTokens.tokenId, tokenId))
      .limit(1);
    return row
      ? { workspaceId: row.workspaceId, agentGrant: row.agentGrant ?? null, serviceAccountId: row.serviceAccountId ?? null }
      : null;
  },
  shouldCache: (row) => row !== null,
});

type TokenBinding = NonNullable<Awaited<ReturnType<typeof loadTokenWorkspaceBinding>>>;

/**
 * Token workspace-scope, computed from the already-loaded binding (no extra
 * query). A session/PAT token bound to a workspace (binding.workspaceId) is refused
 * off that workspace and on account-level requests. A direct service-account
 * bearer has NO account_tokens row (binding null) and is scoped by its own
 * policies, not a token — so it's "in scope" here. A null binding for a
 * non-SA acting id is a revoked/invalid token → out of scope.
 */
export function computeTokenScope(
  binding: TokenBinding | null,
  actingTokenId: string | undefined,
  actorKind: 'member' | 'service_account',
  scope: ActionScopeV2,
  target: AuthorizeTarget,
): boolean {
  if (!actingTokenId) return true; // JWT/browser — no token-scope restriction
  if (!binding) return actorKind === 'service_account'; // direct SA bearer vs. revoked token
  if (!binding.workspaceId) return true; // unscoped PAT → falls through to perms
  if (scope === 'account') return false; // workspace-bound token can't do account actions
  if (target.type !== 'workspace') return false;
  return target.id === binding.workspaceId; // only its bound workspace
}

// A workspace action that an agent grant SHOULD gate. The coarse membership
// actions (read/write, what loadWorkspaceForUser maps onto) are exempt: a route
// that does loadWorkspaceForUser('write') is just checking membership tier, and a
// leaf-scoped agent (e.g. kortixCli=['workspace.gitops.push']) must still pass it —
// the route's own leaf assertAuthorized is what the grant gates. Every OTHER
// workspace action (gitops.*, secret.*, trigger.*, deploy, members.manage, …) is a
// specific capability the agent must hold in its grant.
const AGENT_GRANT_EXEMPT_ACTIONS: ReadonlySet<string> = new Set([
  'workspace.read',
  'workspace.write',
]);

/** Should the agent grant gate this action? Pure — exported for unit tests. */
export function agentGrantGates(scope: ActionScopeV2, action: string): boolean {
  return scope === 'workspace' && !AGENT_GRANT_EXEMPT_ACTIONS.has(action);
}

/**
 * Resolve the principal a request authorizes as.
 *
 * Standing agent identity is OPT-IN per agent: an agent-session token names its
 * agent's auto-provisioned service account, but we authorize AS that SA only
 * once an admin has actually assigned it a role (its iam_policies are non-empty).
 * Until then — and on any resolve miss — we fall back to the LAUNCHING USER
 * (legacy: userRole ∩ agentGrant), so a freshly provisioned, role-less agent
 * keeps working exactly as before instead of collapsing to deny-all. Assigning
 * the agent a role "promotes" it to a true standing teammate on the next authz.
 *
 * This fallback applies ONLY to agent SESSIONS (binding.serviceAccountId). A
 * DIRECT service-account bearer (no account_tokens row → binding null; auth set
 * userId = serviceAccountId) is an explicit SA principal and stays fail-closed:
 * no role assigned → denied.
 */
async function resolveActingActor(
  binding: TokenBinding | null,
  userId: string,
  accountId: string,
): Promise<{ actor: ResolvedActorV2 | null; principalId: string }> {
  if (binding?.serviceAccountId) {
    const sa = await resolveActorV2(binding.serviceAccountId, accountId);
    if (sa && sa.kind === 'service_account' && sa.activated) {
      // Activated (has a role binding) → authorize AS the SA. An empty role here
      // correctly DENIES (deny-by-default), which is how an admin locks an agent
      // down — distinct from "unbound", which falls back below.
      return { actor: sa, principalId: binding.serviceAccountId };
    }
    // Unmanaged agent SA (no binding) or unresolved → authorize as the launcher.
    return { actor: await resolveActorV2(userId, accountId), principalId: userId };
  }
  return { actor: await resolveActorV2(userId, accountId), principalId: userId };
}


// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Core authorization check. Same signature as V1 `authorize` so the
 * dispatch layer can swap them. requestCtx kept for compatibility but
 * unused — V2 has no policy conditions.
 */
export async function authorizeV2(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _requestCtx: RequestContext = {},
): Promise<AuthorizeResult> {
  const scope = scopeForActionV2(action);
  const effectiveTarget: AuthorizeTarget = target ?? { type: 'account' };

  // Load the acting token's binding once (memoized) — it carries the workspace
  // scope, the agent grant, AND the standing-identity service account. JWT/
  // browser requests have no actingTokenId, so they skip this entirely (the
  // common dashboard path resolves the actor directly, unchanged).
  const binding = actingTokenId ? await loadTokenWorkspaceBinding(actingTokenId) : null;

  // STANDING IDENTITY (opt-in): an agent-session token bound to a service account
  // authorizes AS that SA — but ONLY once it has a role; otherwise it falls back
  // to the launching user (see resolveActingActor). effective = (SA role | user
  // role) ∩ agentGrant ∩ the token's workspace scope. A token WITHOUT a
  // service_account_id is unchanged (authorize as the user) — default-safe.
  const { actor } = await resolveActingActor(binding, userId, accountId);
  if (!actor) return { allowed: false, reason: 'not_a_member' };

  // Token workspace-scope short-circuit (computed from the binding, no extra query).
  if (!computeTokenScope(binding, actingTokenId, actor.kind, scope, effectiveTarget)) {
    return { allowed: false, reason: 'token_out_of_scope' };
  }

  // Super-admin bypasses everything else (including MFA gate — flipping
  // the account-MFA toggle must never permanently lock the account out).
  if (actor.isSuperAdmin) {
    return { allowed: true, reason: 'super_admin' };
  }

  // Account-wide MFA gate. JWT/browser sessions only — PATs gate via
  // their own surface (we just verified scope above).
  if (
    actor.accountMfaRequired &&
    !actingTokenId &&
    _requestCtx.mfaAal !== 'aal2'
  ) {
    return { allowed: false, reason: 'account_mfa_required' };
  }

  if (scope === 'account') {
    // A service account has NO membership baseline — its entire authority is its
    // own policies. Only a human member gets the built-in account-role check.
    if (actor.kind === 'member' && accountRoleAllows(actor.accountRole ?? 'member', action)) {
      return { allowed: true, reason: 'account_role' };
    }
    // Built-in role denied (or SA) → DB custom roles (allow-only union).
    if (customPolicyAllows(actor.customActions, scope, action, effectiveTarget)) {
      return { allowed: true, reason: 'custom_policy' };
    }
    return { allowed: false, reason: 'account_role_insufficient' };
  }

  // Workspace scope. The action requires a workspace target.
  if (effectiveTarget.type !== 'workspace') {
    return { allowed: false, reason: 'workspace_target_required' };
  }

  // A custom policy can grant access even with NO built-in workspace role (the
  // department case: a member bound to a scoped custom role via iam_policies and
  // no workspace_members/group GRANT row), so resolve the built-in role but treat
  // it as one source in the union, not a gate.
  // A service account has no workspace membership — its workspace access comes only
  // from its own workspace-scoped (or account-scoped) policies, so skip the
  // member-role resolution entirely for it.
  const effective =
    actor.kind === 'member'
      ? await loadEffectiveWorkspaceRole(actor, userId, effectiveTarget.id)
      : null;
  let reason: string | null = null;
  if (effective && workspaceRoleAllows(effective, action)) reason = 'workspace_role';
  else if (customPolicyAllows(actor.customActions, scope, action, effectiveTarget)) reason = 'custom_policy';

  if (!reason) {
    if (actor.kind === 'service_account') return { allowed: false, reason: 'service_account_scope_insufficient' };
    if (!effective) return { allowed: false, reason: 'no_workspace_membership' };
    return { allowed: false, reason: 'workspace_role_insufficient' };
  }

  // PER-RESOURCE SCOPING (human members only). When the action targets a
  // SPECIFIC agent/skill (target.resource set), intersect the verdict with
  // iam_resource_grants: if that resource is scoped (>=1 grant row), the member
  // must be in the granted set (themselves or one of their groups). Unscoped
  // resources stay workspace-wide — so this never locks anyone out of a resource
  // nobody scoped. Owner/admins keep implicit Manager and bypass; service
  // accounts are governed by their own policies + agentGrant, not this fold.
  if (
    effectiveTarget.type === 'workspace' &&
    effectiveTarget.resource &&
    actor.kind === 'member' &&
    !implicitWorkspaceRoleForAccount(actor.accountRole ?? 'member')
  ) {
    const grants = await loadWorkspaceResourceGrants(effectiveTarget.id, effectiveTarget.resource.type);
    if (!isResourceAccessible(grants.get(effectiveTarget.resource.id), userId, actor.groupIds)) {
      return { allowed: false, reason: 'resource_scope_insufficient' };
    }
  }

  // (standingRole|userRole) ∩ agentGrant — the central enforcement. A scoped
  // agent session token can never exceed its kortix.yaml kortixCli on a specific
  // capability, EVEN when the resolved role (the agent's standing SA role, or the
  // launching user) would allow it. This is the per-task narrowing on top of the
  // standing identity. Enforced here (not per-route) so it can't be forgotten on
  // a new route. No-op for non-agent tokens (null grant) and 'all' grants; exempt
  // for the coarse membership actions (read/write). Reuses the binding loaded above.
  if (actingTokenId && agentGrantGates(scope, action)) {
    if (!agentMayPerform(binding?.agentGrant ?? null, action)) {
      return { allowed: false, reason: 'agent_scope_insufficient' };
    }
  }
  return { allowed: true, reason };
}

/**
 * Batch per-resource filter for list endpoints: given the workspace's agent names
 * / skill slugs, return only the ones the user may access — so the agent/skill
 * lists the UI renders hide what a department isn't scoped to. Resolves the
 * actor ONCE (groupIds + admin bypass) then applies the resource-grant fold in
 * memory. Owner/admins, super-admins, and service accounts see everything (they
 * bypass per-resource scoping, exactly like authorizeV2's fold).
 */
export async function filterAccessibleWorkspaceResources(
  userId: string,
  accountId: string,
  workspaceId: string,
  resourceType: 'agent' | 'skill' | 'secret',
  resourceIds: string[],
  actingTokenId?: string,
): Promise<string[]> {
  if (resourceIds.length === 0) return [];
  const binding = actingTokenId ? await loadTokenWorkspaceBinding(actingTokenId) : null;
  const { actor } = await resolveActingActor(binding, userId, accountId);
  if (!actor) return [];
  if (actor.isSuperAdmin) return resourceIds;
  // SAs are governed by their own policies/agentGrant, not the human fold; and
  // owner/admins keep implicit Manager — both see the full list.
  if (actor.kind !== 'member') return resourceIds;
  if (implicitWorkspaceRoleForAccount(actor.accountRole ?? 'member')) return resourceIds;
  return filterAccessibleResourceIds(workspaceId, resourceType, resourceIds, userId, actor.groupIds);
}

// ─── List accessible resources ─────────────────────────────────────────────

/**
 * Returns the set of workspace IDs the user can perform `action` on.
 * Used by list endpoints to filter without N×authorize round-trips.
 *
 * V2 only supports workspaceresource type — sandboxes/triggers/channels
 * are listed via their owning workspace, not standalone.
 */
export async function listAccessibleWorkspacesV2(
  userId: string,
  accountId: string,
  action: string,
  actingTokenId?: string,
  _requestCtx: RequestContext = {},
): Promise<
  | { mode: 'all' }
  | { mode: 'none' }
  | { mode: 'allow_only'; allowed: Set<string> }
> {
  // Standing identity (opt-in): an activated agent-session SA lists the SA's
  // accessible workspaces; a role-less agent SA falls back to the launching user.
  // (Mirror authorizeV2 via the shared resolver.)
  const binding = actingTokenId ? await loadTokenWorkspaceBinding(actingTokenId) : null;
  const { actor, principalId } = await resolveActingActor(binding, userId, accountId);
  if (!actor) return { mode: 'none' };

  // A token bound to a single workspace narrows the listing to that workspace — for
  // both a human PAT and an agent-session SA. A direct SA bearer has no
  // account_tokens row (binding null) → no narrowing; its own policies drive the
  // listing below. A null binding for a non-SA acting id is a revoked token.
  if (actingTokenId) {
    if (!binding) {
      if (actor.kind !== 'service_account') return { mode: 'none' };
    } else if (binding.workspaceId) {
      // Confirm access to the bound workspace; reuse authorize (re-derives the SA).
      const v = await authorizeV2(
        userId,
        accountId,
        action,
        { type: 'workspace', id: binding.workspaceId },
        actingTokenId,
      );
      return v.allowed ? { mode: 'allow_only', allowed: new Set([binding.workspaceId]) } : { mode: 'none' };
    }
  }

  if (actor.isSuperAdmin) return { mode: 'all' };

  if (
    actor.accountMfaRequired &&
    !actingTokenId &&
    _requestCtx.mfaAal !== 'aal2'
  ) {
    return { mode: 'none' };
  }

  const accountRole = actor.accountRole ?? 'member';

  // Owner/admin: implicit Manager on every workspace. Allowed unless the
  // action isn't in Manager's set.
  if (implicitWorkspaceRoleForAccount(accountRole)) {
    return workspaceRoleAllows('manager', action)
      ? { mode: 'all' }
      : { mode: 'none' };
  }

  // Plain member: union of direct workspace_members + group-derived grants.
  // For each workspace, compute effective role and check if it allows the
  // action. Cheap because the union is bounded by membership count.
  const notExpiredMember = or(
    isNull(workspaceMembers.expiresAt),
    gt(workspaceMembers.expiresAt, sql`now()`),
  );
  const notExpiredGrant = or(
    isNull(workspaceGroupGrants.expiresAt),
    gt(workspaceGroupGrants.expiresAt, sql`now()`),
  );

  const directRows = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.workspaceRole,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(
      and(
        // principalId, not userId: an SA session lists the SA's memberships
        // (none — empty, correct), not the launching human's.
        eq(workspaceMembers.userId, principalId),
        eq(workspaces.accountId, accountId),
        notExpiredMember,
      ),
    );

  let groupRows: Array<{ workspaceId: string; role: WorkspaceRole }> = [];
  if (actor.groupIds.length > 0) {
    const rows = await db
      .select({
        workspaceId: workspaceGroupGrants.workspaceId,
        role: workspaceGroupGrants.role,
      })
      .from(workspaceGroupGrants)
      .where(
        and(
          eq(workspaceGroupGrants.accountId, accountId),
          inArray(workspaceGroupGrants.groupId, actor.groupIds),
          notExpiredGrant,
        ),
      );
    groupRows = rows.flatMap((r) => {
      // Normalize at the DB-read boundary: a legacy `viewer` grant folds into
      // `user`. Drop anything unrecognized rather than feed it to the rank map.
      const role = normalizeWorkspaceRole(r.role);
      return role ? [{ workspaceId: r.workspaceId, role }] : [];
    });
  }

  // Merge by max-role per workspace, then filter by action.
  const byWorkspace = new Map<string, WorkspaceRole>();
  for (const r of directRows) {
    const role = normalizeWorkspaceRole(r.role);
    if (role) byWorkspace.set(r.workspaceId, role);
  }
  for (const r of groupRows) {
    const existing = byWorkspace.get(r.workspaceId);
    byWorkspace.set(r.workspaceId, existing ? maxWorkspaceRole(existing, r.role) : r.role);
  }

  const allowed = new Set<string>();
  for (const [workspaceId, role] of byWorkspace) {
    if (workspaceRoleAllows(role, action)) allowed.add(workspaceId);
  }
  // Fold in DB custom roles (union): an account-scoped policy granting this
  // action covers every workspace; a workspace-scoped one adds just its workspace —
  // so a department member sees the company workspace even with no built-in role.
  for (const ca of actor.customActions) {
    if (ca.action !== action) continue;
    if (ca.scopeType === 'account') return { mode: 'all' };
    if (ca.scopeType === 'workspace' && ca.scopeId) allowed.add(ca.scopeId);
  }
  return { mode: 'allow_only', allowed };
}
