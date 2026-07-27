// Workspace sessions — session CRUD, sharing, public shares, preview candidates.

import { backendApi } from '../../http/api-client';
import { markSessionFresh } from '../../http/fresh-sessions';
import { type ConnectorSharing, unwrap } from './shared';

// ---------------------------------------------------------------------------
// Workspace sessions — one branch + sandbox per row. session_id == sandbox_id
// == branch_name (same UUID), so "Open session" routes to
// /instances/{session_id}/dashboard.
// ---------------------------------------------------------------------------

export type WorkspaceSessionStatus =
  | 'queued'
  | 'branching'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'completed';

export interface WorkspaceSession {
  session_id: string;
  account_id: string;
  workspace_id: string;
  branch_name: string;
  base_ref: string;
  sandbox_provider: 'daytona' | 'platinum' | 'e2b' | null;
  sandbox_id: string;
  sandbox_url: string | null;
  opencode_session_id: string | null;
  /**
   * Resolved display name: the user-set `custom_name` if present, otherwise the
   * auto title mirrored from OpenCode server-side during workspace session reads.
   */
  name: string | null;
  /**
   * The user-set name override (metadata.custom_name). Authoritative — when
   * present it always wins over the server-mirrored OpenCode title. null = no
   * override (display falls back to the auto title / branch).
   */
  custom_name: string | null;
  agent_name: string | null;
  status: WorkspaceSessionStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  opencode_sessions: WorkspaceOpenCodeSession[];
  // Ownership + org-visibility (Phase 2 session sharing).
  created_by?: string | null;
  owner_email?: string | null;
  owner_name?: string | null;
  owner_type?: 'user' | 'service_account' | 'unknown' | null;
  visibility?: 'private' | 'workspace' | 'restricted';
  /** How the session was started — a policy class derived from the caller's
   *  token kind, not the surface. A backend (PAT/service-account) create is
   *  'backend'; a human web session is 'user'. See Kortix-as-a-Backend. */
  origin?: 'user' | 'trigger' | 'schedule' | 'backend' | 'system';
  /** The wrapper's end-user this session acts for (backend origin only). */
  end_user_ref?: string | null;
  /** @deprecated Renamed to `end_user_ref`. Echoed with the same value. */
  origin_ref?: string | null;
  /** The per-session secrets allowlist that was applied (identifiers); null = none. */
  secrets_allowlist?: string[] | null;
  sharing?: ConnectorSharing | null;
  is_owner?: boolean;
  can_manage_sharing?: boolean;
  /** Whether the current viewer may open/read this session. */
  can_access?: boolean;
  /** Exact lifecycle state of the backing runtime resource, when present. */
  runtime_status?: 'provisioning' | 'active' | 'stopped' | 'error' | 'archived' | null;
  /** Server-managed soft-deletion audit fields, present in workspace inventory mode. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionRuntimeContextScalar = string | number | boolean | null;
export type SessionRuntimeContext = Record<string, SessionRuntimeContextScalar>;
export interface SessionConnectorBinding {
  profile_id: string;
}
export type SessionConnectorBindings = Record<string, SessionConnectorBinding>;

/** Public body for POST /workspaces/:workspaceId/sessions. */
export interface CreateWorkspaceSessionInput {
  base_ref?: string;
  agent_name?: string;
  /** Slug of the sandbox template to boot from. Defaults to "default". */
  sandbox_slug?: string;
  initial_prompt?: string;
  opencode_model?: string;
  name?: string;
  /** Client-generated RFC 4122 v4 UUID for optimistic navigation. */
  session_id?: string;
  provider?: 'daytona' | 'platinum' | 'e2b';
  branch_already_created?: boolean;
  metadata?: Record<string, unknown>;
  /** Persisted and injected as one non-secret KORTIX_SESSION_CONTEXT JSON envelope. */
  runtime_context?: SessionRuntimeContext;
  /** Logical connector alias -> active profile available to the caller: their
   * own member profile, a workspace default, or an operator-managed profile when
   * the caller holds the management capability. */
  connector_bindings?: SessionConnectorBindings;
  /**
   * When `connector_bindings` is set, binding any alias normally disables the
   * workspace-default fallback for every OTHER (unbound) alias ("all-or-nothing").
   * `inherit_unbound: true` keeps that fallback, so you can override just one
   * connector (e.g. a user's own account) without re-binding the rest. Only ever
   * inherits the workspace default — never another owner's profile.
   */
  inherit_unbound?: boolean;
  /**
   * Interactive-only: connectors the acting user must have connected themselves
   * for this session (by alias, e.g. `['gmail']`). The server resolves each to
   * the caller's OWN member profile; if one isn't connected, create fails with a
   * structured `CONNECTOR_CONNECTION_REQUIRED` naming the connector so a UI can
   * prompt a connect. Implies `inherit_unbound`. Rejected for backend / service-
   * account tokens (they have no single "current user" — use `connector_bindings`).
   */
  require_connectors?: string[];
  /**
   * Kortix-as-a-Backend (backend-origin callers only — a PAT / service-account
   * bearer). The wrapper's opaque end-user this session acts for; recorded on the
   * session and surfaced to the sandbox as KORTIX_ORIGIN_REF. A non-backend
   * caller supplying it is rejected 403. Attribution only — pass the user's
   * connectors via connector_bindings.
   */
  /** Your opaque handle for the END-USER this session acts for. Backend origin only. */
  end_user_ref?: string;
  /**
   * @deprecated Renamed to `end_user_ref`. Still accepted; sending both is fine
   * only if they agree (disagreeing values are rejected 400).
   */
  origin_ref?: string;
  /**
   * Kortix-as-a-Backend (backend-origin callers only). Narrow which workspace
   * secrets (by identifier) this session's sandbox receives, from the agent's
   * default set down to this list. `[]` = inject zero workspace secrets. Pure
   * narrowing — can't widen beyond the agent's grant. Non-backend caller → 403.
   */
  secrets?: string[];
}

export interface WarmWorkspaceSessionWorkspaceRefresh {
  status: 'skipped' | 'unchanged' | 'updated' | 'failed';
  before_sha?: string | null;
  after_sha?: string | null;
  error?: string;
}

export interface WarmWorkspaceSessionResult {
  session: WorkspaceSession;
  reused: boolean;
  workspace_refresh: WarmWorkspaceSessionWorkspaceRefresh;
}

export interface ClaimWarmWorkspaceSessionInput {
  session_id: string;
  agent_name?: string;
  sandbox_slug?: string;
}

export interface WorkspaceOpenCodeSession {
  id: string;
  title: string | null;
  parent_id: string | null;
  workspace_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  archived_at: number | null;
}

export async function listWorkspaceSessions(
  workspaceId: string,
  options?: { scope?: 'visible' | 'workspace' },
) {
  const query = options?.scope && options.scope !== 'visible' ? `?scope=${options.scope}` : '';
  return unwrap(await backendApi.get<WorkspaceSession[]>(`/workspaces/${workspaceId}/sessions${query}`));
}

/**
 * Set who can see/open a session (private | workspace | members). Owner or
 * workspace manager only. Reuses the connector/secret sharing intent shape.
 */
export async function setWorkspaceSessionSharing(
  workspaceId: string,
  sessionId: string,
  intent: ConnectorSharing,
) {
  return unwrap(
    await backendApi.put<WorkspaceSession>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/sharing`,
      intent,
    ),
  );
}

export interface SessionPreviewCandidate {
  id: string;
  label: string;
  port: number;
  path: string;
  status: 'online' | 'offline' | 'unknown';
  source: string;
}

export interface SessionPublicShare {
  share_id: string;
  session_id: string;
  workspace_id: string;
  resource_type: 'preview' | 'file' | string;
  label: string;
  port: number | null;
  path: string;
  file_path: string | null;
  mode: 'view' | 'interactive' | string;
  allow_websocket: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  public_token?: string;
  public_path?: string;
  proxy_path?: string;
}

export interface CreateSessionPublicShareInput {
  preview_id?: string;
  preview?: {
    label?: string;
    url?: string;
    port?: number;
    path?: string;
  };
  file?: {
    label?: string;
    path: string;
  };
  mode?: 'view' | 'interactive';
  label?: string;
  expires_at?: string | null;
}

export async function getSessionPreviewCandidates(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ candidates: SessionPreviewCandidate[] }>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/previews`,
    ),
  );
}

export async function listSessionPublicShares(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.get<{ shares: SessionPublicShare[] }>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/public-shares`,
      { showErrors: false },
    ),
  );
}

export async function createSessionPublicShare(
  workspaceId: string,
  sessionId: string,
  input: CreateSessionPublicShareInput,
) {
  return unwrap(
    await backendApi.post<{ share: SessionPublicShare }>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/public-shares`,
      input,
    ),
  );
}

export async function revokeSessionPublicShare(
  workspaceId: string,
  sessionId: string,
  shareId: string,
) {
  return unwrap(
    await backendApi.delete<{ share: SessionPublicShare }>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/public-shares/${shareId}`,
    ),
  );
}

export async function createWorkspaceSession(workspaceId: string, input?: CreateWorkspaceSessionInput) {
  const session = unwrap(
    await backendApi.post<WorkspaceSession>(`/workspaces/${workspaceId}/sessions`, input ?? {}),
  );
  // Mark freshly-created EMPTY sessions so the session page shows the instant
  // typeable shell instead of the resume loader. THE chokepoint for every empty
  // workspace-session create path (sidebar button, ⌘T shortcut, command palette).
  // `session_id` is exactly the route param those navigations land on.
  // Skip when an initial_prompt is set: those sessions get a server-side reply,
  // so they must mount the real chat to stream it (the shell would hold it back).
  if (!input?.initial_prompt) {
    markSessionFresh((session as WorkspaceSession | undefined)?.session_id);
  }
  return session;
}

export async function ensureWarmWorkspaceSession(workspaceId: string) {
  const result = unwrap(
    await backendApi.post<WarmWorkspaceSessionResult>(
      `/workspaces/${workspaceId}/sessions/warm`,
      {},
    ),
  );
  markSessionFresh(result.session.session_id);
  return result;
}

export async function claimWarmWorkspaceSession(
  workspaceId: string,
  input: ClaimWarmWorkspaceSessionInput,
) {
  const session = unwrap(
    await backendApi.post<WorkspaceSession>(
      `/workspaces/${workspaceId}/sessions/warm/claim`,
      input,
      { showErrors: false },
    ),
  );
  markSessionFresh(session.session_id);
  return session;
}

export async function getWorkspaceSession(
  workspaceId: string,
  sessionId: string,
  options?: { showErrors?: boolean },
) {
  return unwrap(
    await backendApi.get<WorkspaceSession>(`/workspaces/${workspaceId}/sessions/${sessionId}`, {
      showErrors: options?.showErrors,
    }),
  );
}

/** One governed action an agent took in a session (from the executor audit). */
export interface SessionAuditAction {
  execution_id: string;
  action: string;
  connector_id: string | null;
  /** Connector slug — `${connector}.${action}` is the fully-qualified tool
   *  path workspace policies match against. Null on very old rows whose
   *  connector was deleted. */
  connector?: string | null;
  /** ok | error | denied | pending_approval */
  status: string;
  /** read | write | destructive | null */
  risk: string | null;
  acted_by: string | null;
  acted_by_email: string | null;
  /** Who resolved the gated action — set for both approve and deny; null while
   *  still awaiting a decision. */
  resolved_by: string | null;
  resolved_by_email: string | null;
  result_summary: Record<string, unknown> | null;
  at: string;
  resolved_at: string | null;
}

export interface SessionAudit {
  session_id: string;
  agent: string | null;
  /** False when the account lacks the Enterprise `auditAccess` entitlement —
   *  `actions` then contains only unresolved pending approvals, not the full
   *  historical trail. Absent on older backends (treat as true). */
  audit_access?: boolean;
  count: number;
  actions: SessionAuditAction[];
}

/** Per-session audit trail: every executor-gated action the agent took, with its
 *  risk + allow/ask/block verdict + who resolved it. Visible to anyone who can
 *  see the session (its launcher + workspace managers). */
export async function getSessionAudit(
  workspaceId: string,
  sessionId: string,
  limit?: number,
  options?: { showErrors?: boolean },
) {
  const qs = limit ? `?limit=${limit}` : '';
  return unwrap(
    await backendApi.get<SessionAudit>(`/workspaces/${workspaceId}/sessions/${sessionId}/audit${qs}`, {
      showErrors: options?.showErrors,
    }),
  );
}

export interface SessionTranscriptToolCall {
  tool: string;
  status: string | null;
}

export interface SessionTranscriptMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: SessionTranscriptToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: { name?: string; message?: string } | null;
}

/** Compact server-side transcript read — text + tool calls, stripped of tool
 *  inputs/outputs, for workspace automation (callable with workspace-scoped
 *  session tokens, unlike the raw sandbox proxy). */
export interface SessionTranscript {
  available: boolean;
  reason: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: SessionTranscriptMessage[];
}

export async function getSessionTranscript(
  workspaceId: string,
  sessionId: string,
  options?: { limit?: number; chars?: number },
) {
  const search = new URLSearchParams();
  if (options?.limit != null) search.set('limit', String(options.limit));
  if (options?.chars != null) search.set('chars', String(options.chars));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<SessionTranscript>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/transcript${qs ? `?${qs}` : ''}`,
    ),
  );
}

/** One line of a session's voice-call transcript (`kortix.voice_call_turns`).
 *  'user'/'agent' are either side of the spoken conversation; 'tool' is a
 *  record of an `ask_kortix`/`run_command` call the voice-agent worker made
 *  through the voice MCP (see apps/api/src/channels/voice/mcp.ts) — not
 *  spoken, but part of "what did the voice agent DO" during the call. */
export interface VoiceTranscriptTurn {
  cursor: number;
  role: 'user' | 'agent' | 'tool' | (string & {});
  speaker: string | null;
  text: string;
  at: string;
}

export interface VoiceTranscript {
  session_id: string;
  call_id: string;
  /** Whether a voice-agent worker is in the call's LiveKit room right now. */
  live: boolean;
  /** Highest `cursor` returned — pass back as `cursor` to page for only what's new. */
  cursor: number;
  count: number;
  turns: VoiceTranscriptTurn[];
}

/** A session's live voice-call transcript — every spoken turn plus every
 *  ask_kortix/run_command the worker issued, in one monotonic feed (a call's
 *  `callId` IS its `sessionId`, so there is nothing else to key this by).
 *  Visible to anyone who can see the session (same gate as `/audit`,
 *  `/transcript`). Returns `{ turns: [] }` for a session that never made a
 *  voice call — not a 404, since "no call yet" is the common case. */
export async function getVoiceTranscript(
  workspaceId: string,
  sessionId: string,
  options?: { cursor?: number; limit?: number; showErrors?: boolean },
) {
  const search = new URLSearchParams();
  if (options?.cursor != null) search.set('cursor', String(options.cursor));
  if (options?.limit != null) search.set('limit', String(options.limit));
  const qs = search.toString();
  return unwrap(
    await backendApi.get<VoiceTranscript>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/voice-transcript${qs ? `?${qs}` : ''}`,
      { showErrors: options?.showErrors },
    ),
  );
}

export async function updateWorkspaceSession(
  workspaceId: string,
  sessionId: string,
  input: {
    name?: string;
    metadata?: Record<string, unknown>;
  },
) {
  return unwrap(
    await backendApi.patch<WorkspaceSession>(`/workspaces/${workspaceId}/sessions/${sessionId}`, input),
  );
}

export async function deleteWorkspaceSession(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/workspaces/${workspaceId}/sessions/${sessionId}`),
  );
}

export async function restartWorkspaceSession(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/restart`,
      {},
    ),
  );
}

/** Manual pause: stops the running sandbox in place, resumable via start(). */
export async function stopWorkspaceSession(workspaceId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ ok: boolean; session_id: string; status: string }>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/stop`,
      {},
    ),
  );
}

/**
 * Change the model a session uses, mid-flight.
 *
 * `opencode_model` is set at create; this re-points an existing session. When
 * the sandbox is live the change takes effect immediately (opencode restarts to
 * rebuild its config), which ends any in-flight turn. `applied_live: false`
 * means it was stored and will apply when the sandbox next starts.
 */
export async function setWorkspaceSessionModel(
  workspaceId: string,
  sessionId: string,
  opencodeModel: string,
): Promise<{ opencode_model: string; applied_live: boolean; detail?: string }> {
  return unwrap(
    await backendApi.put<{ opencode_model: string; applied_live: boolean; detail?: string }>(
      `/workspaces/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/model`,
      { opencode_model: opencodeModel },
    ),
  );
}

/** @deprecated Use `setWorkspaceSessionModel`. */
export const setProjectSessionModel = setWorkspaceSessionModel;
