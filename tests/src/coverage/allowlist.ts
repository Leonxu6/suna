export interface AllowEntry {
  method: string;
  path: string;
  reason: string;
}

export const uncoveredAllow: AllowEntry[] = [
  {
    method: "GET",
    path: "/v1/public/voice-join/:*",
    reason:
      "public LiveKit join exchange requires a live call and short-lived join link; integration-voice-join-links.test.ts covers success, unknown, expired, and revoked links",
  },
  {
    method: "GET",
    path: "/v1/public/voice-join/:*/transcript",
    reason:
      "public durable transcript requires a live call and short-lived join link; integration-voice-join-links.test.ts covers pagination, isolation, expiry, and revocation",
  },
  {
    method: "GET",
    path: "/v1/workspaces/:*/sessions/:*/voice-transcript",
    reason:
      "authenticated UI polling route backed by durable voice turns; focused API and web transcript tests cover its contract without allocating a live call",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/sessions/:*/voice-transcript",
    reason:
      "deprecated Project compatibility alias for the canonical Workspace voice-transcript route",
  },
  {
    method: "POST",
    path: "/v1/workspaces/:*/execution-lease",
    reason:
      "sandbox-only execution heartbeat authenticated by a sandbox token; the workspace session contract tests acquire, renew, and release it",
  },
  {
    method: "POST",
    path: "/v1/projects/:*/execution-lease",
    reason:
      "deprecated Project compatibility alias for the sandbox-only Workspace execution-lease route",
  },
  {
    method: "POST",
    path: "/v1/projects/:*/sessions/:*/mcp/voice",
    reason:
      "deprecated Project compatibility alias for the flow-covered Workspace voice MCP route",
  },
  {
    method: "POST",
    path: "/v1/platform/boot-timeline",
    reason:
      "sandbox-only telemetry sink called by the in-guest boot relay with a sandbox token; not an end-user API route",
  },
  {
    method: "PUT",
    path: "/v1/executor/workspaces/:*/connectors/:*/sensitive",
    reason:
      "executor-scoped runtime endpoint — called by the in-sandbox executor with its own token, not by end-user clients; the user-facing equivalent is flow-covered",
  },
  {
    method: "DELETE",
    path: "/v1/workspaces/:*/channels/teams/installation",
    reason: "teams disconnect — manage-ACL teardown symmetric with the flow-covered connect",
  },
  {
    method: "GET",
    path: "/v1/workspaces/:*/channels/teams/manifest",
    reason: "teams sideload manifest — read-only generated artifact",
  },
  {
    method: "GET",
    path: "/v1/channels/teams/identity/login/:*",
    reason: "unauthenticated HTML redirect to the web teams-login page (identity link flow)",
  },
  {
    method: "POST",
    path: "/v1/channels/teams/identity/bind",
    reason: "authed identity bind, hit from the web teams-login page — mirrors the slack identity bind",
  },
  {
    method: "GET",
    path: "/v1/workspaces/:*/channels/teams/file",
    reason: "server-side file download proxy, exercised via the in-sandbox teams CLI, not end-user clients",
  },
  {
    method: "POST",
    path: "/v1/workspaces/:*/channels/teams/file/upload",
    reason: "server-side consent-card upload, exercised via the in-sandbox teams CLI, not end-user clients",
  },
  {
    method: "POST",
    path: "/v1/webhooks/teams/:*/messages",
    reason: "Bot Framework BYO-bot inbound webhook — JWT-authed by Microsoft, same shape as the flow-covered managed /v1/webhooks/teams/messages",
  },
  {
    method: "GET",
    path: "/v1/webhooks/teams/oauth/callback",
    reason: "Teams admin-consent OAuth callback — browser redirect from Microsoft (admin_consent+tenant), not an API client route; mirrors the slack oauth callback",
  },
];

export const externalRoutes: AllowEntry[] = [
  { method: "GET", path: "/v1/llm/models", reason: "llm-gateway standalone service (gateway-*.kortix.com), not in the main API manifest" },
  { method: "GET", path: "/v1/models", reason: "llm-gateway model-catalog alias" },
  { method: "GET", path: "/v1/openai/models", reason: "llm-gateway OpenAI-compat catalog alias" },
  { method: "POST", path: "/v1/chat/completions", reason: "llm-gateway chat completions" },
  { method: "POST", path: "/v1/llm/chat/completions", reason: "llm-gateway chat completions alias" },
  { method: "POST", path: "/v1/openai/chat/completions", reason: "llm-gateway OpenAI-compat chat alias" },
  { method: "POST", path: "/v1/messages", reason: "llm-gateway standalone service Anthropic-Messages ingress" },
  { method: "POST", path: "/v1/openai/messages", reason: "llm-gateway standalone service Anthropic-Messages ingress, OpenAI-compat-namespace alias" },
  { method: "GET", path: "/v1/setup/health", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/install-status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/sandbox-providers", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/setup-status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/bootstrap-owner", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/setup-complete", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
];
