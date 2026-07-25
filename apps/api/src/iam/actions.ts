// Single source of truth for IAM permission strings.
//
// Convention: <resource>.<verb>[.subresource]. The resource prefix MUST match
// one of the iam_resource_type enum values, because the engine uses the prefix
// to know which scope_type a policy needs to grant the action.
//
// Secrets / env-vars are intentionally absent — handled separately later.

export const RESOURCE_TYPES = [
  'account',
  'workspace',
  'sandbox',
  'trigger',
  'channel',
  'member',
  'group',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// ─── Account-scoped actions ────────────────────────────────────────────────
// Always granted via a policy with scope_type='account' (the Everything scope).

export const ACCOUNT_ACTIONS = {
  ACCOUNT_READ: 'account.read',
  ACCOUNT_WRITE: 'account.write',
  ACCOUNT_DELETE: 'account.delete',

  BILLING_READ: 'billing.read',
  BILLING_WRITE: 'billing.write',

  AUDIT_READ: 'audit.read',

  MEMBER_READ: 'member.read',
  MEMBER_INVITE: 'member.invite',
  MEMBER_UPDATE: 'member.update',
  MEMBER_REMOVE: 'member.remove',
  MEMBER_SUPER_ADMIN_GRANT: 'member.super_admin.grant',

  GROUP_READ: 'group.read',
  GROUP_CREATE: 'group.create',
  GROUP_UPDATE: 'group.update',
  GROUP_DELETE: 'group.delete',
  GROUP_MEMBERS_MANAGE: 'group.members.manage',

  POLICY_READ: 'policy.read',
  POLICY_CREATE: 'policy.create',
  POLICY_DELETE: 'policy.delete',

  ROLE_READ: 'role.read',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',

  TOKEN_READ: 'token.read',
  TOKEN_CREATE: 'token.create',
  TOKEN_REVOKE: 'token.revoke',

  // "Create a brand-new workspace" must live at account scope (the workspace
  // doesn't exist yet to scope to).
  WORKSPACE_CREATE: 'workspace.create',
} as const;

// ─── Workspace-scoped actions ────────────────────────────────────────────────
// Can be granted at scope_type='workspace' (a specific workspace) OR at
// scope_type='account' (every workspace in the account).

export const WORKSPACE_ACTIONS = {
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_WRITE: 'workspace.write',
  WORKSPACE_DELETE: 'workspace.delete',
  // Change requests. Distinct from write so an agent can be granted
  // "open a CR" WITHOUT "merge it to the base branch" — merge is the canonical
  // destructive action (it lands code on main), and stays human/explicit.
  WORKSPACE_CR_OPEN: 'workspace.cr.open',
  WORKSPACE_CR_MERGE: 'workspace.cr.merge',

  WORKSPACE_SESSION_READ: 'workspace.session.read',
  WORKSPACE_SESSION_START: 'workspace.session.start',
  WORKSPACE_SESSION_STOP: 'workspace.session.stop',
  WORKSPACE_SESSION_BINDINGS_WRITE: 'workspace.session.bindings.write',

  WORKSPACE_MEMBERS_READ: 'workspace.members.read',
  WORKSPACE_MEMBERS_MANAGE: 'workspace.members.manage',

  WORKSPACE_TRIGGER_READ: 'workspace.trigger.read',
  WORKSPACE_TRIGGER_CREATE: 'workspace.trigger.create',
  WORKSPACE_TRIGGER_UPDATE: 'workspace.trigger.update',
  WORKSPACE_TRIGGER_DELETE: 'workspace.trigger.delete',
  WORKSPACE_TRIGGER_FIRE: 'workspace.trigger.fire',

  WORKSPACE_GATEWAY_LOGS_READ: 'workspace.gateway.logs.read',
  WORKSPACE_GATEWAY_SPEND_READ: 'workspace.gateway.spend.read',
  WORKSPACE_GATEWAY_BUDGET_SET: 'workspace.gateway.budget.set',
  WORKSPACE_GATEWAY_KEYS_MANAGE: 'workspace.gateway.keys.manage',

  // ── Per-capability leaf actions (IAM v1) ────────────────────────────────
  // Each workspace feature gets its own read/write leaf so a custom role can
  // DEACTIVATE one capability (omit the leaf) without losing the rest. Until a
  // route is migrated to assert these, it keeps gating on workspace.read/write,
  // so adding them is additive: every write leaf is also seeded into the Editor
  // built-in role and every read leaf into the User floor role (see
  // role-perms.ts), so no existing editor/user loses a capability. All resolve to 'workspace' scope
  // (prefix = 'workspace') via resourceTypeForAction.
  WORKSPACE_AGENT_READ: 'workspace.agent.read',
  WORKSPACE_AGENT_WRITE: 'workspace.agent.write',
  WORKSPACE_SKILL_READ: 'workspace.skill.read',
  WORKSPACE_SKILL_WRITE: 'workspace.skill.write',
  WORKSPACE_COMMAND_READ: 'workspace.command.read',
  WORKSPACE_COMMAND_WRITE: 'workspace.command.write',
  WORKSPACE_FILE_READ: 'workspace.file.read',
  WORKSPACE_FILE_WRITE: 'workspace.file.write',
  WORKSPACE_CUSTOMIZE_READ: 'workspace.customize.read',
  WORKSPACE_CUSTOMIZE_WRITE: 'workspace.customize.write',
  WORKSPACE_GITOPS_READ: 'workspace.gitops.read',
  WORKSPACE_GITOPS_PUSH: 'workspace.gitops.push',
  WORKSPACE_GITOPS_MERGE: 'workspace.gitops.merge',
  WORKSPACE_SECRET_READ: 'workspace.secret.read',
  WORKSPACE_SECRET_WRITE: 'workspace.secret.write',
  WORKSPACE_CONNECTOR_READ: 'workspace.connector.read',
  WORKSPACE_CONNECTOR_PROFILES_MANAGE: 'workspace.connector.profiles.manage',
  WORKSPACE_CONNECTOR_WRITE: 'workspace.connector.write',

  // Review Center. `read` = see the inbox (floor user). `submit` = an agent puts
  // an output / decision / batch up for human review (floor user + their agent).
  // `act` = approve / reject / request-changes / answer — a consequential
  // decision on agent work, so it sits with the editor tier (like gitops).
  WORKSPACE_REVIEW_READ: 'workspace.review.read',
  WORKSPACE_REVIEW_SUBMIT: 'workspace.review.submit',
  WORKSPACE_REVIEW_ACT: 'workspace.review.act',
} as const;

// ─── Trigger-scoped actions (when scoped to an individual trigger) ─────────

const TRIGGER_ACTIONS = {
  TRIGGER_READ: 'trigger.read',
  TRIGGER_UPDATE: 'trigger.update',
  TRIGGER_DELETE: 'trigger.delete',
  TRIGGER_FIRE: 'trigger.fire',
} as const;

// Channel-scoped actions (channel.read/connect/send/disconnect) were removed
// (dead-catalog cleanup, IAM enforcement audit): they were cataloged with
// resource_type='channel' but never wired to assertWorkspaceCapability (which
// only ever asserts workspace-scoped actions), so granting or omitting them in
// a custom role was a silent no-op. The two routes that needed a real
// send-primitive gate (Slack file upload, meet/speak) were moved onto
// workspace.connector.write instead — see r4.ts.

// ─── Aggregate type for all valid action strings ───────────────────────────

const ALL_ACTIONS = {
  ...ACCOUNT_ACTIONS,
  ...WORKSPACE_ACTIONS,
  ...TRIGGER_ACTIONS,
} as const;

export type Action = (typeof ALL_ACTIONS)[keyof typeof ALL_ACTIONS];

// Set of every valid action string. Used to validate custom-role action
// lists at the API boundary — unknown strings are rejected so a typo can't
// create a role that grants nothing useful.
export const VALID_ACTIONS: ReadonlySet<string> = new Set([
  ...Object.values(ACCOUNT_ACTIONS),
  ...Object.values(WORKSPACE_ACTIONS),
  ...Object.values(TRIGGER_ACTIONS),
]);

/**
 * Catalog grouped for the UI's action picker. Each item carries a human
 * label so the frontend doesn't have to title-case dotted strings.
 */
export interface ActionCatalogEntry {
  action: string;
  label: string;
  resourceType: ResourceType;
}

function label(action: string): string {
  return action
    .split('.')
    .map((part) => part[0]?.toUpperCase() + part.slice(1).replace(/_/g, ' '))
    .join(' · ');
}

export const ACTION_CATALOG: ActionCatalogEntry[] = [
  ...Object.values(ACCOUNT_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
  ...Object.values(WORKSPACE_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
  ...Object.values(TRIGGER_ACTIONS).map((a) => ({
    action: a,
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
];

/**
 * Returns the resource_type the engine should match against for a given
 * action. Derived from the dotted prefix.
 *
 * workspace.session.stop   → 'workspace'
 * sandbox.start          → 'sandbox'
 * member.invite          → 'account'  (account-level member admin)
 */
export function resourceTypeForAction(action: string): ResourceType {
  const prefix = action.split('.', 1)[0] as ResourceType;
  // Member / group / role / policy / token / billing / audit / account_*
  // are all account-scoped admin actions.
  if (
    prefix === 'account' ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action === 'workspace.create'
  ) {
    return 'account';
  }
  // Otherwise the prefix is itself a resource type.
  if ((RESOURCE_TYPES as readonly string[]).includes(prefix)) {
    return prefix;
  }
  // Defensive fallback — unknown action always requires account scope.
  return 'account';
}
