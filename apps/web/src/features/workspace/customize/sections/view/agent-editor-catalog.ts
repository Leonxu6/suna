/**
 * Field-space catalogs for the agent editor — pulled out of agent-editor.tsx
 * so the modal file stays focused on composition. Pure data, no React.
 */

export const AGENT_MODES = ['primary', 'subagent', 'all'] as const;
export const AGENT_MODE_HELP: Record<(typeof AGENT_MODES)[number], string> = {
  primary: 'Selectable as the main agent for a session.',
  subagent: 'Callable by other agents only — not selectable directly.',
  all: 'Available both as primary and as a subagent.',
};
export const THEME_COLORS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const;
export const WORKSPACE_MODES = ['runtime', 'read', 'branch'] as const;
export const WORKSPACE_MODE_HELP: Record<(typeof WORKSPACE_MODES)[number], string> = {
  runtime: 'Works directly in the live workspace workspace.',
  read: 'Can read files but cannot modify them.',
  branch: 'Works on an isolated git branch, merged in later.',
};
export const PERMISSION_ACTIONS = ['allow', 'ask', 'deny'] as const;

// Permission keys that accept the full rule form (bare action OR glob-map).
// `skill` is intentionally EXCLUDED — the Skills governance control below owns
// `permission.skill` (the compiler maps `skills:` onto it), so exposing it here
// too would give two controls fighting over one key.
export const PERMISSION_RULE_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'lsp',
] as const;
// Permission keys that only ever take a bare action (no glob-map form upstream).
export const PERMISSION_ACTION_ONLY_KEYS = [
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'doom_loop',
] as const;

export const PERMISSION_RULE_GROUPS: { label: string; keys: (typeof PERMISSION_RULE_KEYS)[number][] }[] = [
  { label: 'Files & search', keys: ['read', 'edit', 'glob', 'grep', 'list'] },
  { label: 'Execution', keys: ['bash', 'task', 'external_directory', 'lsp'] },
];

export const PERMISSION_KEY_HELP: Record<string, string> = {
  read: 'Read file contents.',
  edit: 'Create or modify files.',
  glob: 'Find files by name pattern.',
  grep: 'Search file contents by pattern.',
  list: 'List directory contents.',
  bash: 'Run shell commands.',
  task: 'Launch a subagent to run a task.',
  external_directory: 'Access paths outside this workspace workspace.',
  lsp: 'Use language-server tooling — go-to-definition, diagnostics.',
  todowrite: "Maintain the session's todo list.",
  question: 'Ask the user a clarifying question mid-run.',
  webfetch: "Fetch a URL's contents.",
  websearch: 'Run a web search.',
  doom_loop: 'Auto-break a detected repeat-failure loop.',
};

/**
 * The grantable `kortix_cli` action catalog, grouped for the picker. MUST stay
 * in sync with `GRANTABLE_KORTIX_CLI_ACTIONS` in @kortix/manifest-schema (=
 * WORKSPACE_ACTIONS in apps/api iam/actions.ts — every workspace-scoped action,
 * including the manager-tier leaves workspace.delete / workspace.members.manage /
 * workspace.gateway.keys.manage, still reachable via a workspace's `manager`
 * role). Mirrored here (not imported) because the manifest-schema/api
 * packages aren't in the web bundle — same mirror discipline as
 * apps/web/src/lib/workspace-actions.ts. Kept in sync by
 * agent-editor.test.tsx's drift guard against the real
 * `GRANTABLE_KORTIX_CLI_ACTIONS` constant.
 *
 * Account-scoped admin actions (member.*, billing.*, token.*, workspace.create,
 * …) are ALSO absent — but that omission is a UX curation choice, not the
 * security boundary: every agent-session token is workspace-scoped, and
 * apps/api's IAM v2 engine refuses any account-scope action for a
 * workspace-bound token before an agent's grant is even consulted (see
 * `iam/engine-v2.ts`'s `computeTokenScope`).
 */
export const KORTIX_CLI_CATALOG: { group: string; actions: string[] }[] = [
  { group: 'Workspace', actions: ['workspace.read', 'workspace.write', 'workspace.delete'] },
  { group: 'Change requests', actions: ['workspace.cr.open', 'workspace.cr.merge'] },
  {
    group: 'Sessions',
    actions: [
      'workspace.session.read',
      'workspace.session.start',
      'workspace.session.stop',
      'workspace.session.bindings.write',
    ],
  },
  { group: 'Members', actions: ['workspace.members.read', 'workspace.members.manage'] },
  {
    group: 'Triggers',
    actions: [
      'workspace.trigger.read',
      'workspace.trigger.create',
      'workspace.trigger.update',
      'workspace.trigger.delete',
      'workspace.trigger.fire',
    ],
  },
  {
    group: 'LLM gateway',
    actions: [
      'workspace.gateway.logs.read',
      'workspace.gateway.spend.read',
      'workspace.gateway.budget.set',
      'workspace.gateway.keys.manage',
    ],
  },
  {
    group: 'Configuration',
    actions: [
      'workspace.agent.read',
      'workspace.agent.write',
      'workspace.skill.read',
      'workspace.skill.write',
      'workspace.command.read',
      'workspace.command.write',
      'workspace.file.read',
      'workspace.file.write',
      'workspace.customize.read',
      'workspace.customize.write',
    ],
  },
  {
    group: 'Git',
    actions: ['workspace.gitops.read', 'workspace.gitops.push', 'workspace.gitops.merge'],
  },
  { group: 'Secrets', actions: ['workspace.secret.read', 'workspace.secret.write'] },
  {
    group: 'Connectors',
    actions: [
      'workspace.connector.read',
      'workspace.connector.write',
      'workspace.connector.profiles.manage',
    ],
  },
  {
    group: 'Review',
    actions: ['workspace.review.read', 'workspace.review.submit', 'workspace.review.act'],
  },
];
