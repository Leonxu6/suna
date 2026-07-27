import {
  type SessionConnectorBindings,
  SessionConnectorBindingsSchema,
} from '@kortix/api-contract';
import {
  executorConnectionProfiles,
  executorConnectors,
  workspaceSessionConnectorBindings,
  workspaceSessions,
  serviceAccounts,
} from '@kortix/db';
import { fromPersistedConnectorOwnerType } from './persistence';
import { and, desc, eq } from 'drizzle-orm';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
} from '../../shared/connector-alias';
import { db } from '../../shared/db';

export interface ValidatedSessionConnectorBinding {
  alias: string;
  profileId: string;
  connectorId: string;
  ownerType: 'workspace' | 'agent' | 'member' | 'subject' | 'external';
  ownerId: string | null;
}

export interface ResolvedSessionConnectorProfile {
  profileId: string;
  connectorId: string;
  alias: string;
  status: 'active' | 'revoked' | 'error';
  isDefault: boolean;
  metadata: Record<string, unknown>;
  source: 'request' | 'default';
}

export function mayUseLegacyDefaultProfile(hasAnyDurableBinding: boolean): boolean {
  return !hasAnyDurableBinding;
}

// Canonicalization lives in shared/ so pure IAM code can use it without
// inheriting this module's database dependency. Imported for local use and
// re-exported so existing importers are unaffected.
export { canonicalConnectorAlias, publicConnectorAlias };

export async function loadEmailInstallProfileId(
  workspaceId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      metadata: executorConnectionProfiles.metadata,
      status: executorConnectionProfiles.status,
    })
    .from(executorConnectionProfiles)
    .innerJoin(
      executorConnectors,
      eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
    )
    .where(
      and(
        eq(executorConnectionProfiles.workspaceId, workspaceId),
        eq(executorConnectors.slug, canonicalConnectorAlias('email')),
      ),
    );
  return (
    rows.find(
      (row) =>
        row.status === 'active' && (row.metadata as Record<string, unknown>)?.inbox_id === inboxId,
    )?.profileId ?? null
  );
}

export async function ensureEmailSessionBinding(input: {
  workspaceId: string;
  sessionId: string;
  inboxId: string;
}): Promise<boolean> {
  const profileId = await loadEmailInstallProfileId(input.workspaceId, input.inboxId);
  if (!profileId) return false;
  const [profile] = await db
    .select({
      accountId: executorConnectionProfiles.accountId,
      connectorId: executorConnectionProfiles.connectorId,
    })
    .from(executorConnectionProfiles)
    .where(eq(executorConnectionProfiles.profileId, profileId))
    .limit(1);
  const [session] = await db
    .select({ accountId: workspaceSessions.accountId })
    .from(workspaceSessions)
    .where(
      and(
        eq(workspaceSessions.sessionId, input.sessionId),
        eq(workspaceSessions.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!profile || !session || profile.accountId !== session.accountId) return false;
  await db
    .insert(workspaceSessionConnectorBindings)
    .values({
      sessionId: input.sessionId,
      accountId: session.accountId,
      workspaceId: input.workspaceId,
      connectorAlias: canonicalConnectorAlias('email'),
      connectorId: profile.connectorId,
      profileId,
      source: 'default',
      createdBy: null,
    })
    .onConflictDoNothing();
  const [binding] = await db
    .select({ profileId: workspaceSessionConnectorBindings.profileId })
    .from(workspaceSessionConnectorBindings)
    .where(
      and(
        eq(workspaceSessionConnectorBindings.sessionId, input.sessionId),
        eq(workspaceSessionConnectorBindings.connectorAlias, canonicalConnectorAlias('email')),
      ),
    )
    .limit(1);
  return binding?.profileId === profileId;
}

export function parseSessionConnectorBindings(
  value: unknown,
): { ok: true; bindings: SessionConnectorBindings | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, bindings: undefined };
  const parsed = SessionConnectorBindingsSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, bindings: parsed.data };
}

export async function validateSessionConnectorBindings(input: {
  accountId: string;
  workspaceId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  mayManageSystemProfiles: boolean;
  bindings: SessionConnectorBindings | undefined;
}): Promise<
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | { ok: false; error: string; code: string }
> {
  if (!input.bindings) return { ok: true, bindings: [] };

  const validated: ValidatedSessionConnectorBinding[] = [];
  for (const [requestedAlias, binding] of Object.entries(input.bindings)) {
    const alias = canonicalConnectorAlias(requestedAlias);
    const [row] = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorId: executorConnectionProfiles.connectorId,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        isDefault: executorConnectionProfiles.isDefault,
        status: executorConnectionProfiles.status,
        connectorEnabled: executorConnectors.enabled,
      })
      .from(executorConnectionProfiles)
      .innerJoin(
        executorConnectors,
        and(
          eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
          eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
          eq(executorConnectors.workspaceId, executorConnectionProfiles.workspaceId),
        ),
      )
      .where(
        and(
          eq(executorConnectionProfiles.profileId, binding.profile_id),
          eq(executorConnectionProfiles.accountId, input.accountId),
          eq(executorConnectionProfiles.workspaceId, input.workspaceId),
          eq(executorConnectors.slug, alias),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        ok: false,
        error: `Connector profile is not available for alias "${alias}" in this workspace`,
        code: 'CONNECTOR_PROFILE_NOT_FOUND',
      };
    }
    const ownerType = fromPersistedConnectorOwnerType(row.ownerType);
    const mayUseProfile =
      (ownerType === 'member' &&
        row.ownerId === input.actingUserId &&
        !input.actingPrincipalIsServiceAccount) ||
      // Any workspace-owned connection may be bound explicitly, not only the
      // default one: a connector can now hold several TEAM connections (e.g.
      // support@ and sales@) and naming one by profile_id is exactly how a
      // caller picks between them. They all belong to this workspace.
      ownerType === 'workspace' ||
      // Anything left here is a SYSTEM profile (agent/subject/external) — the
      // workspace case is already handled above.
      (ownerType !== 'member' && input.mayManageSystemProfiles);
    if (!mayUseProfile) {
      // Deliberately match the cross-workspace response. A profile id is not an
      // authority, and callers must not be able to probe another member's
      // connected identities (including when the caller is a workspace manager).
      return {
        ok: false,
        error: `Connector profile is not available for alias "${alias}" in this workspace`,
        code: 'CONNECTOR_PROFILE_NOT_FOUND',
      };
    }
    if (row.status !== 'active') {
      return {
        ok: false,
        error: `Connector profile for alias "${alias}" is not active`,
        code: 'CONNECTOR_PROFILE_INACTIVE',
      };
    }
    if (!row.connectorEnabled) {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is disabled`,
        code: 'CONNECTOR_PROFILE_INACTIVE',
      };
    }
    validated.push({
      alias,
      profileId: row.profileId,
      connectorId: row.connectorId,
      ownerType,
      ownerId: row.ownerId,
    });
  }
  return { ok: true, bindings: validated };
}

export type RequiredConnectorResolution =
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | { ok: false; connector: string; error: string; code: 'CONNECTOR_CONNECTION_REQUIRED' };

/**
 * Resolve each REQUIRED connector alias to the ACTING USER's OWN active member
 * connection profile. Unlike validateSessionConnectorBindings (which verifies a
 * caller-supplied profile_id), this DISCOVERS the user's own profile by
 * (owner_type='member', owner_id, connector slug). If the user has not connected
 * a required connector — or it is revoked/disabled, or the caller is a service
 * account with no personal identity — it fails CONNECTOR_CONNECTION_REQUIRED,
 * naming the PUBLIC alias so the UI can prompt a connect. Returned bindings share
 * the ValidatedSessionConnectorBinding shape and merge into the same persist path;
 * being member-owned they force the session private, and the caller forces
 * inherit_unbound so the agent's other connectors keep their workspace defaults.
 */
export async function resolveRequiredMemberConnectorProfiles(input: {
  accountId: string;
  workspaceId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  aliases: readonly string[];
}): Promise<RequiredConnectorResolution> {
  const bindings: ValidatedSessionConnectorBinding[] = [];
  const seen = new Set<string>();
  for (const requestedAlias of input.aliases) {
    const alias = canonicalConnectorAlias(requestedAlias);
    if (seen.has(alias)) continue;
    seen.add(alias);
    const publicAlias = publicConnectorAlias(alias);
    // A service account has no personal ("member") identity, so it can never
    // satisfy a personal-connection requirement — fail closed (the caller also
    // rejects backend origin up front; this is defense in depth).
    if (input.actingPrincipalIsServiceAccount) {
      return {
        ok: false,
        connector: publicAlias,
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        error: `Connector "${publicAlias}" requires a personal connection`,
      };
    }
    const [row] = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorId: executorConnectionProfiles.connectorId,
        ownerId: executorConnectionProfiles.ownerId,
      })
      .from(executorConnectionProfiles)
      .innerJoin(
        executorConnectors,
        and(
          eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
          eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
          eq(executorConnectors.workspaceId, executorConnectionProfiles.workspaceId),
        ),
      )
      .where(
        and(
          eq(executorConnectionProfiles.accountId, input.accountId),
          eq(executorConnectionProfiles.workspaceId, input.workspaceId),
          eq(executorConnectionProfiles.ownerType, 'member'),
          eq(executorConnectionProfiles.ownerId, input.actingUserId),
          eq(executorConnectors.slug, alias),
          // Filter to USABLE rows in the query, not after LIMIT 1. A member may
          // now hold several connections on one connector, so fetching an
          // arbitrary row and then rejecting it would report "connect your
          // account" while a perfectly good active connection sits right there.
          eq(executorConnectionProfiles.status, 'active'),
          eq(executorConnectors.enabled, true),
        ),
      )
      // Deterministic pick: the member's own DEFAULT wins. Without this, "use my
      // gmail" would choose arbitrarily between e.g. their "Work" and "Personal"
      // accounts — i.e. act as the wrong account on a coin flip. Tie-break on
      // profileId so the choice is stable across calls when no default is set.
      .orderBy(desc(executorConnectionProfiles.isDefault), executorConnectionProfiles.profileId)
      .limit(1);
    if (!row) {
      return {
        ok: false,
        connector: publicAlias,
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        error: `Connect your "${publicAlias}" account to start this session`,
      };
    }
    bindings.push({
      alias,
      profileId: row.profileId,
      connectorId: row.connectorId,
      ownerType: 'member',
      ownerId: row.ownerId,
    });
  }
  return { ok: true, bindings };
}

export async function persistSessionConnectorBindings(input: {
  sessionId: string;
  accountId: string;
  workspaceId: string;
  createdBy: string;
  bindings: ValidatedSessionConnectorBinding[];
}): Promise<void> {
  if (input.bindings.length === 0) return;
  await db.insert(workspaceSessionConnectorBindings).values(
    input.bindings.map((binding) => ({
      sessionId: input.sessionId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      connectorAlias: binding.alias,
      connectorId: binding.connectorId,
      profileId: binding.profileId,
      source: 'request' as const,
      createdBy: input.createdBy,
    })),
  );
}

export function sessionConnectorBindingsRequirePrivateVisibility(
  bindings: readonly ValidatedSessionConnectorBinding[],
): boolean {
  return bindings.some((binding) => binding.ownerType === 'member');
}

export async function sessionHasMemberConnectorBinding(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ profileId: workspaceSessionConnectorBindings.profileId })
    .from(workspaceSessionConnectorBindings)
    .innerJoin(
      executorConnectionProfiles,
      eq(executorConnectionProfiles.profileId, workspaceSessionConnectorBindings.profileId),
    )
    .where(
      and(
        eq(workspaceSessionConnectorBindings.sessionId, input.sessionId),
        eq(workspaceSessionConnectorBindings.accountId, input.accountId),
        eq(workspaceSessionConnectorBindings.workspaceId, input.workspaceId),
        eq(executorConnectionProfiles.ownerType, 'member'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Resolve the effective profile on every Executor request. A present but
 * revoked/error binding never falls through to a workspace default.
 */
export async function resolveSessionConnectorProfile(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string | null;
  alias: string;
}): Promise<ResolvedSessionConnectorProfile | null> {
  if (input.sessionId) {
    const [session] = await db
      .select({
        sessionId: workspaceSessions.sessionId,
        createdBy: workspaceSessions.createdBy,
        visibility: workspaceSessions.visibility,
        inheritUnbound: workspaceSessions.connectorBindingsInheritUnbound,
        createdByServiceAccountId: serviceAccounts.serviceAccountId,
      })
      .from(workspaceSessions)
      .leftJoin(
        serviceAccounts,
        and(
          eq(serviceAccounts.serviceAccountId, workspaceSessions.createdBy),
          eq(serviceAccounts.accountId, workspaceSessions.accountId),
        ),
      )
      .where(
        and(
          eq(workspaceSessions.sessionId, input.sessionId),
          eq(workspaceSessions.accountId, input.accountId),
          eq(workspaceSessions.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (!session) return null;

    const [bound] = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        connectorId: executorConnectionProfiles.connectorId,
        status: executorConnectionProfiles.status,
        isDefault: executorConnectionProfiles.isDefault,
        metadata: executorConnectionProfiles.metadata,
        ownerType: executorConnectionProfiles.ownerType,
        ownerId: executorConnectionProfiles.ownerId,
        source: workspaceSessionConnectorBindings.source,
      })
      .from(workspaceSessionConnectorBindings)
      .innerJoin(
        executorConnectionProfiles,
        eq(executorConnectionProfiles.profileId, workspaceSessionConnectorBindings.profileId),
      )
      .where(
        and(
          eq(workspaceSessionConnectorBindings.sessionId, input.sessionId),
          eq(workspaceSessionConnectorBindings.accountId, input.accountId),
          eq(workspaceSessionConnectorBindings.workspaceId, input.workspaceId),
          eq(workspaceSessionConnectorBindings.connectorAlias, input.alias),
        ),
      )
      .limit(1);
    if (bound) {
      if (
        bound.ownerType === 'member' &&
        (session.createdByServiceAccountId !== null ||
          bound.ownerId !== session.createdBy ||
          session.visibility !== 'private')
      ) {
        return null;
      }
      return {
        profileId: bound.profileId,
        connectorId: bound.connectorId,
        status: bound.status,
        isDefault: bound.isDefault,
        source: bound.source,
        alias: input.alias,
        metadata: bound.metadata ?? {},
      };
    }

    // Once a session opts into durable profile selection, every connector must
    // be selected explicitly. Falling back for an unbound alias would let a
    // partially bound session inherit an unrelated workspace-wide credential.
    //
    // Only a caller-REQUESTED binding (`source: 'request'`) counts as opting in.
    // A `source: 'default'` row is auto-wired by the platform — today only
    // `ensureEmailSessionBinding` mints one when an inbound email lands on a
    // session — and must NOT trip the all-or-nothing gate: otherwise auto-binding
    // the email inbox would silently disable the workspace-default fallback for
    // every OTHER connector (slack, meet, …) on that session, which the caller
    // never chose. The auto email binding still resolves via its own bound row
    // above; this gate governs only the UNBOUND aliases.
    //
    // A session created with `inherit_unbound` opts OUT of all-or-nothing: an
    // unbound alias keeps falling through to the workspace default below. Safe
    // because the fallback query only ever returns the workspace's `isDefault`
    // profile for this exact account+workspace+alias — never another owner's or a
    // member/external profile — so it can neither escalate nor cross a tenant.
    if (!session.inheritUnbound) {
      const [anyBinding] = await db
        .select({ sessionId: workspaceSessionConnectorBindings.sessionId })
        .from(workspaceSessionConnectorBindings)
        .where(
          and(
            eq(workspaceSessionConnectorBindings.sessionId, input.sessionId),
            eq(workspaceSessionConnectorBindings.accountId, input.accountId),
            eq(workspaceSessionConnectorBindings.workspaceId, input.workspaceId),
            eq(workspaceSessionConnectorBindings.source, 'request'),
          ),
        )
        .limit(1);
      if (!mayUseLegacyDefaultProfile(Boolean(anyBinding))) return null;
    }
  }

  const [fallback] = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      connectorId: executorConnectionProfiles.connectorId,
      status: executorConnectionProfiles.status,
      isDefault: executorConnectionProfiles.isDefault,
      metadata: executorConnectionProfiles.metadata,
    })
    .from(executorConnectionProfiles)
    .innerJoin(
      executorConnectors,
      and(
        eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
        eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
        eq(executorConnectors.workspaceId, executorConnectionProfiles.workspaceId),
      ),
    )
    .where(
      and(
        eq(executorConnectionProfiles.accountId, input.accountId),
        eq(executorConnectionProfiles.workspaceId, input.workspaceId),
        eq(executorConnectionProfiles.isDefault, true),
        // The unbound-alias fallback must only reach the workspace's shared
        // default. Defaults are per-owner now (a member can mark one of their own
        // connections default), so without this filter a session with no explicit
        // binding could resolve to some member's PERSONAL connection — acting as
        // the wrong account, across users. Fail to the team connection or nothing.
        eq(executorConnectionProfiles.ownerType, 'project'),
        eq(executorConnectors.slug, input.alias),
      ),
    )
    .limit(1);
  if (!fallback) return null;
  return {
    ...fallback,
    alias: input.alias,
    metadata: fallback.metadata ?? {},
    source: 'default',
  };
}

export function canonicalConnectorBindings(value: unknown): string {
  const parsed = parseSessionConnectorBindings(value);
  if (!parsed.ok || !parsed.bindings) return '{}';
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed.bindings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([alias, binding]) => [alias, { profile_id: binding.profile_id }]),
    ),
  );
}

export function connectorBindingPayloadConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalConnectorBindings(existing) !== canonicalConnectorBindings(requested);
}
