// Workspaces — workspace CRUD, detail, experimental features, warm pool, onboarding.

import { type ApiClientOptions, backendApi } from '../../http/api-client';
import type { SandboxProviderName } from '../platform-client/types';
import {
  type WorkspaceFileEntry,
  type WorkspaceGitConnection,
  type WorkspaceRole,
  type ServerTokenOptions,
  normalizeServerBackendBase,
  serverTokenGet,
  unwrap,
} from './shared';

/** Stable ids for experimental features (mirrors apps/api experimental/features). */
export type ExperimentalFeatureKey =
  | 'agent_tunnel'
  | 'marketplace'
  | 'connectors_api_discover'
  | 'agentmail_email'
  | 'voice'
  | 'llm_gateway'
  | 'acp_runtime'
  | 'review_center';

/** One experimental feature as described by the API catalog. */
export interface ExperimentalFeatureView {
  key: ExperimentalFeatureKey;
  name: string;
  description: string;
  stability: 'experimental' | 'beta';
  /** Platform supports it (operator env). When false the UI hides the toggle. */
  available: boolean;
  /** Effective per-workspace state (the switch position). */
  enabled: boolean;
  /** True when this workspace set an explicit choice (vs inheriting the default). */
  overridden: boolean;
}

export interface KortixWorkspace {
  workspace_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  workspace_role?: WorkspaceRole | null;
  effective_workspace_role?: WorkspaceRole | null;
  /** Effective on/off for each experimental feature for THIS workspace. */
  experimental?: Record<ExperimentalFeatureKey, boolean>;
  /** Full experimental-feature catalog (drives Customize → Settings →
   *  Experimental). Self-describing so the UI never hard-codes the list. */
  experimental_features?: ExperimentalFeatureView[];
  /** Effective per-workspace warm sandbox pool config (Customize → Sandbox). */
  warm_pool?: { enabled: boolean; size: number };
  /** Whether the warm pool feature is enabled platform-wide (gates the UI). */
  warm_pool_available?: boolean;
  /** Per-workspace sandbox-provider pin (Customize → Settings). null = follow the
   *  platform default/distribution. */
  default_sandbox_provider?: SandboxProviderName | null;
  /** Enabled sandbox providers the picker offers (ALLOWED ∩ has-API-key). */
  available_sandbox_providers?: SandboxProviderName[];
}

export interface WorkspaceConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  open_code_raw: string | null;
  /** Provider-neutral workspace default. The SDK derives this from legacy servers. */
  default_agent?: string | null;
  /** @deprecated Use `default_agent`. */
  open_code_default_agent: string | null;
  agent_discovery: 'opencode' | 'declarative';
  agents: Array<{
    name: string;
    path: string;
    description: string | null;
    mode: string | null;
    source?: 'opencode' | 'kortix.toml';
    enabled?: boolean;
    /** Agent-specific sandbox template. null or absent inherits the project default. */
    sandbox?: string | null;
    /** Per-agent governance from `kortix.yaml` `agents:` (read-only mirror).
     *  `'all'` = unscoped; a list = the allowlist; `[]` = none. Absent for
     *  OpenCode-discovered agents (not governed by `agents:`). */
    scope?: {
      env: string[] | 'all';
      connectors: string[] | 'all';
      kortix_cli: string[] | 'all';
    };
  }>;
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
  env: { required: string[]; optional: string[] };
}

export interface WorkspaceDetail {
  workspace: KortixWorkspace;
  git_connection?: WorkspaceGitConnection | null;
  config: WorkspaceConfigSummary;
  file_count: number;
  files: WorkspaceFileEntry[];
}

/**
 * A single model as served by the workspace LLM catalog endpoint. Mirrors the
 * API's `GatewayModel` (apps/api/src/llm-gateway/models/catalog-models.ts) —
 * keep the two in sync. Declaring the full shape here is what lets the web's
 * `flattenModels` read `provider` (and the models.dev passthrough fields)
 * without an `as any` cast: this interface is the only place between the API
 * and the picker where the field could go undeclared.
 */
export interface GatewayCatalogModel {
  name: string;
  free?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
  variants?: Record<string, Record<string, unknown>>;
  /**
   * The REAL upstream provider serving this model ('anthropic', 'openai',
   * 'amazon-bedrock', ...). Every gateway model is registered under the one
   * synthetic `kortix` opencode provider, so this is the ONLY reliable way to
   * group/label a model by who actually serves it — Bedrock ids are
   * dot-namespaced (`us.anthropic.claude-opus-4-8`), so the legacy
   * split-on-slash heuristic cannot recover it.
   */
  provider?: string;
  release_date?: string;
  released?: string;
  family?: string;
  cost?: { input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  description?: string;
  open_weights?: boolean;
  last_updated?: string;
}

export interface WorkspaceLlmCatalogResponse {
  models: Record<string, GatewayCatalogModel>;
}

export interface WorkspaceInput {
  account_id?: string;
  name?: string;
  repo_url: string;
  default_branch?: string;
  manifest_path?: string;
}

export interface CreateWorkspaceRepoInput {
  account_id?: string;
  name: string;
  installation_id?: string;
  private?: boolean;
  description?: string;
  starter_template?: 'general-knowledge-worker' | 'minimal';
  /** Clone a `registry:project` item into the new GitHub repository. */
  source_item_id?: string;
}

export interface ProvisionWorkspaceInput {
  account_id?: string;
  name: string;
  /** Seed the managed repo with the Kortix starter so sessions can boot. */
  seed_starter?: boolean;
  starter_template?: 'general-knowledge-worker' | 'minimal';
  marketplace_items?: string[];
  /** Clone a `registry:project` marketplace item instead of the blank
   *  starter — e.g. `"kortix-projects:support-agent-kit"`. Implies
   *  seed_starter and takes precedence over starter_template. */
  source_item_id?: string;
}

export interface RepoCollaboratorInvite {
  username: string;
  permission: string;
  /** Pending-invitation URL to accept on GitHub, or null if already a collaborator. */
  invitationUrl: string | null;
  alreadyCollaborator: boolean;
}

export async function listWorkspaces() {
  return unwrap(await backendApi.get<KortixWorkspace[]>('/workspaces'));
}

export async function listWorkspacesForAccount(accountId?: string) {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(await backendApi.get<KortixWorkspace[]>(`/workspaces${query}`));
}

export async function getWorkspace(workspaceId: string, options?: ApiClientOptions) {
  return unwrap(await backendApi.get<KortixWorkspace>(`/workspaces/${workspaceId}`, options));
}

/**
 * Invite a GitHub user as a collaborator on a MANAGED repo — lets the workspace
 * creator pull "their" Kortix-managed repo into their own GitHub account.
 */
export async function inviteRepoCollaborator(
  workspaceId: string,
  githubUsername: string,
  permission: 'read' | 'write' = 'write',
) {
  return unwrap(
    await backendApi.post<RepoCollaboratorInvite>(`/workspaces/${workspaceId}/git/collaborators`, {
      github_username: githubUsername,
      permission,
    }),
  );
}

export interface ManifestValidationIssue {
  [key: string]: unknown;
}

export interface ManifestValidationResult {
  valid: boolean;
  issues: ManifestValidationIssue[];
}

/**
 * Validate a `kortix.toml` manifest's raw TOML text server-side — the same
 * schema the CLI (`kortix ship` pre-flight / `kortix validate`) and the CR-merge
 * gate exercise. Always resolves (never throws on an invalid manifest) — the
 * verdict is in the body.
 */
export async function validateWorkspaceManifest(
  workspaceId: string,
  raw: string,
): Promise<ManifestValidationResult> {
  return unwrap(
    await backendApi.post<ManifestValidationResult>(`/workspaces/${workspaceId}/manifest/validate`, {
      raw,
    }),
    'Failed to validate manifest',
  );
}

export interface WorkspaceGitToken {
  push_token: string;
  /** Provider-selected HTTP Basic username (`x-access-token` for GitHub, `t` for Code Storage). */
  git_username: string;
  repo_id: string | null;
  repo_url: string | null;
}

/**
 * Mint a fresh scoped git push token for a *managed* workspace (so the CLI can
 * `kortix ship` without persisting credentials in git config). Throws (409)
 * for BYO workspaces — they push with the user's own git remote auth.
 */
export async function getWorkspaceGitToken(workspaceId: string): Promise<WorkspaceGitToken> {
  return unwrap(
    await backendApi.post<WorkspaceGitToken>(`/workspaces/${workspaceId}/git-token`, {}),
    'Failed to mint git token',
  );
}

/** True when this workspace's repo is a Kortix-managed GitHub repo (invitable). */
export function isManagedGithubWorkspace(workspace: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  const git = (workspace.metadata as { git?: { provider?: string; managed?: boolean } } | undefined)
    ?.git;
  return git?.provider === 'github' && git?.managed === true;
}

export async function getWorkspaceDetail(workspaceId: string, options?: ApiClientOptions) {
  const detail = unwrap(
    await backendApi.get<WorkspaceDetail>(`/workspaces/${workspaceId}/detail`, {
      showErrors: false,
      ...options,
    }),
  );
  return {
    ...detail,
    config: {
      ...detail.config,
      default_agent: detail.config.default_agent ?? detail.config.open_code_default_agent ?? null,
    },
  };
}

export async function getWorkspaceLlmCatalog(workspaceId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<WorkspaceLlmCatalogResponse>(`/workspaces/${workspaceId}/llm-catalog`, {
      showErrors: false,
      ...options,
    }),
  );
}

/**
 * Load the compact, connection-aware catalog intended for interactive model
 * selectors. Unlike `getWorkspaceLlmCatalog`, this does not transfer the complete
 * runtime models.dev projection used to configure OpenCode sandboxes.
 */
export async function getWorkspaceModelPicker(workspaceId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<WorkspaceLlmCatalogResponse>(`/workspaces/${workspaceId}/model-picker`, {
      showErrors: false,
      ...options,
    }),
  );
}

/** One provider row from the live, server-refreshed models.dev catalog. */
export interface WorkspaceLlmCatalogProvider {
  id: string;
  name: string;
  env?: string[];
  doc?: string | null;
  api?: string | null;
  npm?: string | null;
  models: Array<{ id: string; name: string; released: string | null }>;
}

export interface WorkspaceLlmCatalogProvidersResponse {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
  providers: WorkspaceLlmCatalogProvider[];
}

/**
 * The PROVIDER-level rows of the live runtime catalog — id/name/env/doc per
 * provider, the shape the connect modal (apps/web/src/lib/llm-providers.ts)
 * needs. Unlike `getWorkspaceLlmCatalog`/`getWorkspaceModelPicker`, works for
 * native (non-gateway) workspaces too — see the route's doc comment
 * (apps/api/src/workspaces/routes/r4.ts, `/llm-catalog/providers`).
 */
export async function getWorkspaceLlmCatalogProviders(workspaceId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<WorkspaceLlmCatalogProvidersResponse>(
      `/workspaces/${workspaceId}/llm-catalog/providers`,
      { showErrors: false, ...options },
    ),
  );
}

export async function createWorkspace(input: WorkspaceInput) {
  return unwrap(await backendApi.post<KortixWorkspace>('/workspaces', input));
}

export async function createWorkspaceRepo(input: CreateWorkspaceRepoInput) {
  return unwrap(await backendApi.post<KortixWorkspace>('/workspaces/create-repo', input));
}

/**
 * Create a workspace backed by a managed Kortix git repo — the
 * default. No GitHub account or repo-name uniqueness needed; the starter is
 * seeded server-side so the workspace boots immediately.
 */
export async function provisionProject(
  input: ProvisionProjectInput,
  options: ApiClientOptions = {},
) {
  return unwrap(
    await backendApi.post<KortixProject>(
      '/projects/provision',
      {
        seed_starter: true,
        ...input,
      },
      {
        timeout: 120_000,
        ...options,
      },
    ),
  );
}

export interface ManagedGitStatus {
  configured: boolean;
  provider: string;
}

/**
 * Whether the managed-git "Create workspace" path (provisionWorkspace/POST
 * /workspaces/provision) is usable on this server. Lets the create-workspace UI
 * pre-check and disable/annotate that option instead of letting the user hit
 * a 503 — self-host deployments with no MANAGED_GIT_* configured are the
 * primary case (the BYO-repo import path stays available regardless).
 * `showErrors: false` — a failure here is a soft "assume unavailable", not
 * something that should ever surface as a toast of its own.
 */
export async function getManagedGitStatus(): Promise<ManagedGitStatus> {
  try {
    return unwrap(
      await backendApi.get<ManagedGitStatus>('/workspaces/managed-git/status', {
        showErrors: false,
      }),
    );
  } catch {
    return { configured: false, provider: 'github' };
  }
}

export async function updateWorkspace(workspaceId: string, input: Partial<WorkspaceInput>) {
  return unwrap(await backendApi.patch<KortixWorkspace>(`/workspaces/${workspaceId}`, input));
}

/** Toggle an experimental feature for a workspace (Customize → Settings →
 *  Experimental). Pass `enabled: null` to clear the override and fall back to
 *  the operator default. */
export async function updateExperimentalFeature(
  workspaceId: string,
  feature: ExperimentalFeatureKey,
  enabled: boolean | null,
) {
  return unwrap(
    await backendApi.patch<KortixWorkspace>(`/workspaces/${workspaceId}/experimental`, {
      feature,
      enabled,
    }),
  );
}

/**
 * The durable provider-migration transition the API returns on the PATCH prepare
 * branch (a switch to a different, non-default enabled provider — e.g.
 * Daytona→Platinum) and that {@link getWorkspaceSandboxProviderTransition} polls.
 * Distinguished from a plain workspace by `kind:'preparation'`. The switch does NOT
 * flip the active provider synchronously; the target image is built + verified
 * first, then activated, and the client polls until a terminal `status`.
 */
type WorkspaceIdentity =
  | { workspace_id: string; project_id?: string }
  | { workspace_id?: string; project_id: string };

export type PreparationView = WorkspaceIdentity & {
  kind: 'preparation';
  transition_id: string | null;
  /** ProviderTransitionStatus | 'noop' | 'cleared' — see the transition core. */
  status: string;
  source_provider: string | null;
  target_provider: string | null;
  active_provider: string | null;
  label: string;
  generation: number | null;
  snapshot_name: string | null;
  external_template_id: string | null;
  commit_sha: string | null;
  attempts: number;
  last_error: string | null;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
};

/**
 * The result of {@link updateWorkspaceSandboxProvider}: EITHER the updated workspace
 * (a safe/immediate switch — null clear, the platform default, or the
 * already-active provider) tagged `kind:'workspace'`, OR a {@link PreparationView}
 * (the prepare branch) tagged `kind:'preparation'`. Both arrive under HTTP 200 —
 * branch on `kind`, never shape-sniff. A `kind:'preparation'` result must NOT be
 * written into the workspace cache; poll
 * {@link getWorkspaceSandboxProviderTransition} until it settles.
 */
export type UpdateWorkspaceSandboxProviderResult =
  | ({ kind: 'workspace' } & KortixWorkspace)
  | PreparationView;

/** Set or clear the per-workspace sandbox-provider pin (Customize → Settings).
 *  Pass `null` to clear (follow the platform default/distribution). The value must
 *  be one of the workspace's `available_sandbox_providers`.
 *
 *  Returns a tagged union (see {@link UpdateWorkspaceSandboxProviderResult}): a
 *  `kind:'workspace'` immediate result, or a `kind:'preparation'` transition the
 *  caller polls via {@link getWorkspaceSandboxProviderTransition}. */
export async function updateWorkspaceSandboxProvider(
  workspaceId: string,
  provider: SandboxProviderName | null,
): Promise<UpdateWorkspaceSandboxProviderResult> {
  return unwrap(
    await backendApi.patch<UpdateWorkspaceSandboxProviderResult>(
      `/workspaces/${workspaceId}/sandbox-provider`,
      { provider },
    ),
  );
}

/** PUBLIC provider-migration transition view served by the poll endpoint. Carries
 *  only status / providers / generation / timestamps / a user-safe error class +
 *  label — never internal build/lease detail. */
export type SandboxProviderTransitionView = WorkspaceIdentity & {
  transition_id: string | null;
  status: string;
  source_provider: string | null;
  target_provider: string | null;
  generation: number | null;
  label: string;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
};

export interface SandboxProviderTransitionState {
  active_provider: string | null;
  latest: SandboxProviderTransitionView | null;
  history: SandboxProviderTransitionView[];
}

/** Poll the durable per-workspace sandbox-provider migration. After
 *  {@link updateWorkspaceSandboxProvider} returns a `kind:'preparation'` result,
 *  poll this until `latest` reaches a terminal status (activated / failed /
 *  superseded / cancelled) — or `latest` is null (no live transition). */
export async function getWorkspaceSandboxProviderTransition(
  workspaceId: string,
  options?: ApiClientOptions,
) {
  return unwrap(
    await backendApi.get<SandboxProviderTransitionState>(
      `/workspaces/${workspaceId}/sandbox-provider/transition`,
      { showErrors: false, ...options },
    ),
  );
}

/**
 * Configure the warm sandbox pool for one sandbox template (Customize → Sandbox).
 * Warm pool is per-template + opt-in; `slug` selects which template (defaults to
 * the platform default). Live ready/warming counts come back on each template via
 * `listWorkspaceSnapshots`.
 */
export async function updateTemplateWarmPool(
  workspaceId: string,
  input: { slug: string; enabled?: boolean; size?: number },
) {
  return unwrap(await backendApi.patch<KortixWorkspace>(`/workspaces/${workspaceId}/warm-pool`, input));
}

export async function setWorkspaceOnboardingComplete(workspaceId: string, completed: boolean) {
  return unwrap(
    await backendApi.patch<KortixWorkspace>(`/workspaces/${workspaceId}/onboarding`, { completed }),
  );
}

export async function archiveWorkspace(workspaceId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/workspaces/${workspaceId}`));
}

// ── Server-side explicit-token variants ──────────────────────────────────────
// Next.js server actions / route handlers (post-signup first-workspace
// bootstrap) run per-request with an already-resolved Supabase access token —
// they must not rely on the SDK's process-wide `configureKortix()` seam.

/**
 * Server-side / explicit-token variant of {@link listWorkspacesForAccount}.
 * Returns `null` on any failure.
 */
export async function fetchWorkspacesForAccountWithToken(
  opts: ServerTokenOptions,
  accountId: string,
): Promise<KortixWorkspace[] | null> {
  return serverTokenGet<KortixWorkspace[]>(
    opts,
    `/v1/workspaces?account_id=${encodeURIComponent(accountId)}`,
  );
}

export type ProvisionWorkspaceWithTokenResult =
  | { ok: true; workspace: KortixWorkspace }
  | { ok: false; limitReached: boolean };

/**
 * Server-side / explicit-token variant of {@link provisionWorkspace}. Mirrors
 * the original bootstrap behavior: a 403 with `code: 'workspace_limit_reached'`
 * is reported distinctly so the caller can fall back to re-listing existing
 * workspaces instead of treating it as a hard failure.
 */
export async function provisionWorkspaceWithToken(
  opts: ServerTokenOptions,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionWorkspaceWithTokenResult> {
  if (!opts.backendUrl || !opts.accessToken) return { ok: false, limitReached: false };
  const base = normalizeServerBackendBase(opts.backendUrl);
  try {
    const res = await fetch(`${base}/v1/workspaces/provision`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seed_starter: true, ...input }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    if (res.ok) {
      const workspace = (await res.json().catch(() => null)) as KortixWorkspace | null;
      // A 200 whose body doesn't actually carry a workspace_id is not a usable
      // success — report it as not-ok instead of handing the caller a workspace
      // it can't build a `/workspaces/{id}` path from.
      if (!workspace?.workspace_id) return { ok: false, limitReached: false };
      return { ok: true, workspace };
    }
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      return { ok: false, limitReached: body?.code === 'workspace_limit_reached' };
    }
    return { ok: false, limitReached: false };
  } catch {
    return { ok: false, limitReached: false };
  }
}
