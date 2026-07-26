/**
 * Workspaces — miscellaneous workspace-scoped surfaces that don't fit the core CRUD
 * flow: BYO-repo create, the CLI-token (workspace PAT)
 * lifecycle, onboarding state, version-diff preview, ChatGPT headless provider
 * auth and the Slack-relay turn endpoints.
 *
 * Maps to spec §13 (WS-2 for BYO create; WS-9..WS-17 minted here).
 */
import { flow } from "../core/flow";

// WS-2 — BYO repo create. A non-GitHub repo_url is rejected at the
// normalizeRepoUrl boundary (400) before any GitHub round-trip; MEMBER /
// NONMEMBER are denied by PROJECT_CREATE (403). We assert the boundary only —
// a real 201 needs a GitHub App install + reachable repo, which the harness
// can't guarantee.
flow(
  "WS-2",
  { domain: "workspaces", routes: ["POST /v1/workspaces"] },
  async (ctx) => {
    await ctx.step("non-GitHub repo_url → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces", { name: ctx.fixtures.name("byo"), repo_url: "https://gitlab.com/acme/widget" });
      r.status(400);
    });
    await ctx.step("http:// (non-HTTPS) repo_url → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces", { name: ctx.fixtures.name("byo"), repo_url: "http://github.com/acme/widget" });
      r.status(400);
    });
    await ctx.step("ANON cannot create → 401", async () => {
      // (Any authenticated user CAN create a workspace in their own account, so a
      // cross-tenant 403 isn't the boundary here — unauth is.)
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/workspaces", { name: ctx.fixtures.name("byo"), repo_url: "https://github.com/acme/widget" });
      r.status(401);
    });
  },
);

// WS-10 — CLI-token lifecycle. POST mints a real workspace-scoped PAT
// (returns secret_key + token_id, 201); GET lists it; DELETE revokes it.
// Mutating + minting a credential → serial.
flow(
  "WS-10",
  {
    domain: "workspaces",
    routes: [
      "POST /v1/workspaces/:workspaceId/cli-token",
      "GET /v1/workspaces/:workspaceId/cli-token",
      "DELETE /v1/workspaces/:workspaceId/cli-token/:tokenId",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    let tokenId = "";
    await ctx.step("mint a CLI token → 201", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/cli-token", { name: ctx.fixtures.name("cli") }, { params: { workspaceId: p.id } });
      r.status(201).body().exists("$.token_id").exists("$.secret_key").has("$.workspace_id", p.id);
      tokenId = r.json<any>().token_id;
      ctx.track("cli-token", tokenId, { workspaceId: p.id });
    });
    await ctx.step("list CLI tokens → 200 includes minted", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:workspaceId/cli-token", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.items");
    });
    await ctx.step("revoke CLI token → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:workspaceId/cli-token/:tokenId", { params: { workspaceId: p.id, tokenId } });
      r.status(200).body().has("$.ok", true);
    });
    await ctx.step("revoke unknown token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:workspaceId/cli-token/:tokenId", {
          params: { workspaceId: p.id, tokenId: "00000000-0000-4000-a000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER cannot mint → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/workspaces/:workspaceId/cli-token", {}, { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

// WS-11 — onboarding state. PATCH {completed:true|false} flips
// metadata.onboarding_completed_at and echoes the serialized workspace (200).
flow(
  "WS-11",
  { domain: "workspaces", routes: ["PATCH /v1/workspaces/:workspaceId/onboarding"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("mark onboarding completed → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/workspaces/:workspaceId/onboarding", { completed: true }, { params: { workspaceId: p.id } });
      r.status(200).body().has("$.workspace_id", p.id);
    });
    await ctx.step("reset onboarding → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/workspaces/:workspaceId/onboarding", { completed: false }, { params: { workspaceId: p.id } });
      r.status(200);
    });
    await ctx.step("NONMEMBER cannot patch → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/workspaces/:workspaceId/onboarding", { completed: true }, { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

// WS-12 — version-diff preview. Requires `from` + `into` query params (400
// without). Same ref short-circuits to is_same_ref:true (200) with no git
// round-trip; a real cross-ref diff may 400 if a ref can't be resolved.
flow(
  "WS-12",
  { domain: "workspaces", routes: ["GET /v1/workspaces/:workspaceId/version-diff"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("missing from/into → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:workspaceId/version-diff", { params: { workspaceId: p.id } });
      r.status(400);
    });
    await ctx.step("same ref → 200 is_same_ref", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/version-diff", { params: { workspaceId: p.id }, query: { from: "main", into: "main" } });
      r.status(200).body().has("$.is_same_ref", true);
    });
    await ctx.step("cross-ref diff → 200 or 400 (unresolvable ref)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/version-diff", {
          params: { workspaceId: p.id },
          query: { from: "does-not-exist", into: "main" },
        });
      r.status([200, 400]);
    });
  },
);

// WS-13 — provider OAuth device flow (poll-based). `start` kicks the device
// flow and returns a challenge; the client polls `poll` until it resolves; the
// resulting login is saved as CODEX_AUTH_JSON. `list`/`delete` manage it. We
// assert the boundaries only — completing a real device login needs a live
// ChatGPT account the harness can't drive, and calling `start` for a real
// provider would spawn a server-side OpenCode flow, so we exercise `start`'s
// unknown-provider guard instead.
flow(
  "WS-13",
  {
    domain: "workspaces",
    routes: [
      "POST /v1/workspaces/:workspaceId/oauth/:provider/start",
      "POST /v1/workspaces/:workspaceId/oauth/:provider/poll",
      "GET /v1/workspaces/:workspaceId/oauth",
      "DELETE /v1/workspaces/:workspaceId/oauth/:provider",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("start unknown provider → 400 (no flow spawned)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/oauth/:provider/start", {}, { params: { workspaceId: p.id, provider: "nope" } });
      r.status(400);
    });
    await ctx.step("start invalid sharing → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:workspaceId/oauth/:provider/start",
          { sharing: { mode: "bogus" } },
          { params: { workspaceId: p.id, provider: "openai" } },
        );
      r.status(400);
    });
    await ctx.step("poll missing flow_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/oauth/:provider/poll", {}, { params: { workspaceId: p.id, provider: "openai" } });
      r.status(400);
    });
    await ctx.step("poll bogus flow_id → 200 expired", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:workspaceId/oauth/:provider/poll",
          { flow_id: "00000000-0000-4000-a000-000000000000" },
          { params: { workspaceId: p.id, provider: "openai" } },
        );
      r.status(200).body().has("$.status", "expired");
    });
    await ctx.step("list configured OAuth → 200 items", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:workspaceId/oauth", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.items");
    });
    await ctx.step("delete unknown provider → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:workspaceId/oauth/:provider", { params: { workspaceId: p.id, provider: "nope" } });
      r.status(404);
    });
    await ctx.step("NONMEMBER start → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/workspaces/:workspaceId/oauth/:provider/start", {}, { params: { workspaceId: p.id, provider: "openai" } });
      r.status([403, 404]);
    });
    await ctx.step("ANON list → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/workspaces/:workspaceId/oauth", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// WS-16 — turn-question relay. A normal user token authorizes via workspace
// read; the relay validates session_id first, then scopes it to the workspace,
// then validates questions. A missing id is 400; an unknown id is 404. We assert the
// no-session negative so it runs locally without a live OpenCode session.
flow(
  "WS-16",
  { domain: "workspaces", routes: ["POST /v1/workspaces/:workspaceId/turn-question"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("missing session_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/turn-question", { questions: [{ question: "q?" }] }, { params: { workspaceId: p.id } });
      r.status(400);
    });
    await ctx.step("unknown session takes precedence over missing questions → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/turn-question", { session_id: "bogus" }, { params: { workspaceId: p.id } });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/workspaces/:workspaceId/turn-question", { session_id: "bogus", questions: [] }, { params: { workspaceId: p.id } });
      r.status([400, 403, 404]);
    });
  },
);

// WS-17 — turn-stream relay. Same auth model as turn-question; the body gate
// requires session_id first, then scopes it to the workspace before interpreting
// the event payload. Asserting the negative
// keeps this local (no funded session required).
flow(
  "WS-17",
  { domain: "workspaces", routes: ["POST /v1/workspaces/:workspaceId/turn-stream"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("missing session_id + text → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/turn-stream", { kind: "step" }, { params: { workspaceId: p.id } });
      r.status(400);
    });
    await ctx.step("unknown session takes precedence over missing text → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/turn-stream", { session_id: "bogus" }, { params: { workspaceId: p.id } });
      r.status(404);
    });
    await ctx.step("kind=turn_end with an unknown session → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:workspaceId/turn-stream",
          { session_id: "bogus", kind: "turn_end", status: "idle" },
          { params: { workspaceId: p.id } },
        );
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/workspaces/:workspaceId/turn-stream", { session_id: "bogus", text: "hi" }, { params: { workspaceId: p.id } });
      r.status([400, 403, 404]);
    });
  },
);

// WS-19 — Full v2 agent-config editor (the "agent builder" surface, spec
// docs/specs/2026-07-05-agent-first-config-unification.md §2.2). GET reports the
// agent's full block + the manifest schema version (the UI's v1-vs-v2 branch);
// PUT replaces the whole block, validating it through the manifest-schema
// validator before the kortix.yaml commit. A bare provisioned workspace now
// synthesizes a v2 manifest (synthesizeBlankManifest, kortix_version 2 — see
// PR #4980), so GET reports schema_version 2 and editable:true. PUT still
// validates the block shape strictly: a body with unrecognized top-level keys
// (or a bad enum) is refused with a 400; the editor-tier gate holds.
flow(
  "WS-19",
  {
    domain: "workspaces",
    routes: [
      "GET /v1/workspaces/:workspaceId/agents/:agentName/config",
      "PUT /v1/workspaces/:workspaceId/agents/:agentName/config",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const workspace = await team.workspace();

    await ctx.step("GET reports schema_version 2 / editable true for a synthesized blank manifest", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/agents/:agentName/config", {
          params: { workspaceId: workspace.id, agentName: "kortix" },
        });
      r.status(200).body().has("$.schema_version", 2).has("$.editable", true);
    });

    await ctx.step("PUT a body with unrecognized top-level keys → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/workspaces/:workspaceId/agents/:agentName/config",
          { mode: "primary", description: "Support", temperature: 0.2 },
          { params: { workspaceId: workspace.id, agentName: "kortix" } },
        );
      r.status(400);
    });

    await ctx.step("PUT with a malformed body (bad enum) → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/workspaces/:workspaceId/agents/:agentName/config",
          { mode: "supervisor" },
          { params: { workspaceId: workspace.id, agentName: "kortix" } },
        );
      r.status(400);
    });

    await ctx.step("a member with no workspace grant cannot read/write the config → 403", async () => {
      const bare = await team.addMember("member");
      const r = await ctx.client
        .as(bare)
        .get("/v1/workspaces/:workspaceId/agents/:agentName/config", {
          params: { workspaceId: workspace.id, agentName: "kortix" },
        });
      r.status(403);
    });
  },
);

// WS-20 — managed-git pre-flight status. GET /managed-git/status lets the
// "Create workspace" UI pre-check whether the managed-git provision path is
// usable BEFORE the user hits its 503 (self-host deploys with no
// MANAGED_GIT_* configured). Auth-gated, account-scoped (NOT workspace-scoped —
// the path has no :workspaceId, it reports the server-wide managed-git backend).
// Read-only and safe to assert the happy path on staging.
flow(
  "WS-20",
  { domain: "workspaces", routes: ["GET /v1/workspaces/managed-git/status"] },
  async (ctx) => {
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/workspaces/managed-git/status");
      r.status(401);
    });
    await ctx.step("OWNER → 200 with {configured, provider}", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/managed-git/status");
      r.status(200).body().exists("$.configured").exists("$.provider");
      const provider = r.json<any>()?.provider;
      if (typeof provider !== "string" || provider.length === 0) {
        throw new Error(`expected a non-empty provider string, got: ${provider}`);
      }
      // `configured` is a boolean — never a 500, never an unset field.
      if (typeof r.json<any>()?.configured !== "boolean") {
        throw new Error(`expected configured to be a boolean, got: ${r.json<any>()?.configured}`);
      }
    });
  },
);

// WS-27 — model-defaults CRUD. GET reads the platform/account/workspace/agent
// defaults; PUT upserts one scope (agent requires agentName); DELETE clears
// one scope by query. PUT rejects models that the account cannot serve. The
// flow reads the current workspace picker and selects a managed model from that
// served catalog. Full set → read-back → clear lifecycle on scope=workspace.
flow(
  "WS-27",
  {
    domain: "workspaces",
    requires: ["funded"],
    routes: [
      "GET /v1/workspaces/:workspaceId/model-picker",
      "GET /v1/workspaces/:workspaceId/model-defaults",
      "PUT /v1/workspaces/:workspaceId/model-defaults",
      "DELETE /v1/workspaces/:workspaceId/model-defaults",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    let servableModel = "";
    await ctx.step("GET before any override → 200 with no workspace default", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/model-defaults", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.platformDefault").has("$.workspaceDefault", null);
    });
    await ctx.step("GET model picker → select a served managed model", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/model-picker", { params: { workspaceId: p.id } });
      r.status(200);
      const models = r.json<any>()?.models;
      const candidate =
        models && typeof models === "object"
          ? Object.keys(models).find((model) => model !== "auto" && !model.includes("/"))
          : undefined;
      if (!candidate) {
        throw new Error(`model-picker returned no managed model: ${r.text()}`);
      }
      servableModel = candidate;
    });
    await ctx.step("PUT scope=workspace sets a concrete model → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/workspaces/:workspaceId/model-defaults",
          { scope: "workspace", model: servableModel },
          { params: { workspaceId: p.id } },
        );
      r.status(200).body().has("$.ok", true).has("$.scope", "workspace").has("$.model", servableModel);
    });
    await ctx.step("GET reflects the set workspace default", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/model-defaults", { params: { workspaceId: p.id } });
      r.status(200).body().has("$.workspaceDefault", servableModel).has("$.resolvedForCaller", servableModel);
    });
    await ctx.step("PUT with the synthetic auto id → 409 (not servable)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/workspaces/:workspaceId/model-defaults",
          { scope: "workspace", model: "auto" },
          { params: { workspaceId: p.id } },
        );
      r.status(409).body().has("$.code", "model_not_servable");
    });
    await ctx.step("PUT scope=agent without agentName → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/workspaces/:workspaceId/model-defaults",
          { scope: "agent", model: servableModel },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("DELETE scope=workspace clears the override → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:workspaceId/model-defaults", {
          params: { workspaceId: p.id },
          query: { scope: "workspace" },
        });
      r.status(200).body().has("$.ok", true);
    });
    await ctx.step("GET reflects the clear", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/model-defaults", { params: { workspaceId: p.id } });
      r.status(200).body().has("$.workspaceDefault", null);
    });
    await ctx.step("DELETE with an invalid scope → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:workspaceId/model-defaults", {
          params: { workspaceId: p.id },
          query: { scope: "bogus" },
        });
      r.status(400);
    });
    await ctx.step("NONMEMBER cannot read → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/workspaces/:workspaceId/model-defaults", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

// WS-28 — Suna-migration status surface. Top-level `/v1/workspaces/suna-migration/*`
// (NOT workspace-scoped, despite the path prefix) — scoped to the caller's own
// account. eligible = the account has legacy `public.projects` rows AND no
// completed/in-flight migration yet. A fresh e2e account (synthesized per run)
// has neither, so this asserts the real "nothing to migrate" shape rather than
// kicking off a real migration against production Suna data.
flow(
  "WS-28",
  {
    domain: "workspaces",
    routes: [
      "GET /v1/workspaces/suna-migration/eligibility",
      "GET /v1/workspaces/suna-migration/status",
      "POST /v1/workspaces/suna-migration/start",
    ],
  },
  async (ctx) => {
    await ctx.step("GET eligibility for a fresh account → 200, not eligible", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/suna-migration/eligibility");
      r.status(200).body().has("$.eligible", false).has("$.migration", null);
    });
    await ctx.step("GET status for a fresh account → 200, no migration on record", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/suna-migration/status");
      r.status(200).body().has("$.migration", null);
    });
    await ctx.step("POST start for a non-eligible account → 400 (nothing to migrate)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/workspaces/suna-migration/start", {});
      r.status(400);
    });
    await ctx.step("ANON cannot read eligibility → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/workspaces/suna-migration/eligibility");
      r.status(401);
    });
  },
);

// WS-29 — manifest validation (dry-run, no commit). Body: { raw, format? }.
// Always resolves — the verdict lives in the body, never a raw parser 4xx —
// except the caller-input guards (missing `raw`) which are the real 400s.
flow(
  "WS-29",
  { domain: "workspaces", routes: ["POST /v1/workspaces/:workspaceId/manifest/validate"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("missing raw → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/manifest/validate", { format: "yaml" }, { params: { workspaceId: p.id } });
      r.status(400);
    });
    await ctx.step("a valid minimal v2 manifest → 200 valid:true", async () => {
      const raw = "kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n";
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:workspaceId/manifest/validate",
          { raw, format: "yaml" },
          { params: { workspaceId: p.id } },
        );
      r.status(200).body().has("$.valid", true);
    });
    await ctx.step("a broken manifest (default_agent not declared) → 200 valid:false with issues", async () => {
      const raw = "kortix_version: 2\ndefault_agent: does-not-exist\nagents:\n  kortix: {}\n";
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:workspaceId/manifest/validate",
          { raw, format: "yaml" },
          { params: { workspaceId: p.id } },
        );
      r.status(200).body().has("$.valid", false).exists("$.issues");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/workspaces/:workspaceId/manifest/validate",
          { raw: "kortix_version: 2\n", format: "yaml" },
          { params: { workspaceId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);

// WS-30 — set the workspace default agent. `kortix.yaml.default_agent` is
// durable truth; workspace.metadata.default_agent mirrors it for reads. A fresh
// provisioned workspace now synthesizes a blank v2 manifest with a `kortix`
// agent already declared (see WS-19), so setting it back to `kortix` is a
// safe, real no-op write (still commits to git) that proves the success path.
flow(
  "WS-30",
  {
    domain: "workspaces",
    timeoutMs: 240_000,
    routes: ["PUT /v1/workspaces/:workspaceId/default-agent"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.workspace({ seed: true });
    await ctx.step("set default agent to the existing 'kortix' agent → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/workspaces/:workspaceId/default-agent", { agent: "kortix" }, { params: { workspaceId: p.id } });
      r.status(200).body().has("$.ok", true).has("$.default_agent", "kortix");
    });
    await ctx.step("unknown agent name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/workspaces/:workspaceId/default-agent",
          { agent: "does-not-exist" },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("empty agent name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/workspaces/:workspaceId/default-agent", { agent: "" }, { params: { workspaceId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/workspaces/:workspaceId/default-agent", { agent: "kortix" }, { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

// WS-31 — per-workspace sandbox-provider pin. `null`/`''` clears the pin
// (follow the platform default/distribution); a concrete value must be an
// ENABLED provider (in ALLOWED_SANDBOX_PROVIDERS with its API key configured)
// or 400. A concrete provider can start a durable cross-provider image build.
// The provider-transition flows cover that behavior. This route contract uses
// the deterministic clear operation, which always returns immediately.
flow(
  "WS-31",
  { domain: "workspaces", routes: ["PATCH /v1/workspaces/:workspaceId/sandbox-provider"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("unknown/disabled provider → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/workspaces/:workspaceId/sandbox-provider",
          { provider: "not-a-real-provider" },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("clear the provider pin → 200 (immediate, kind:workspace)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/workspaces/:workspaceId/sandbox-provider", { provider: null }, { params: { workspaceId: p.id } });
      r.status(200).body().has("$.kind", "workspace").has("$.default_sandbox_provider", null);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/workspaces/:workspaceId/sandbox-provider", { provider: "daytona" }, { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch("/v1/workspaces/:workspaceId/sandbox-provider", { provider: "daytona" }, { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// WS-32 — the BYOK-provider-connect-modal catalog. Serves the SAME live,
// 24h-refreshed `runtimeModelCatalog.snapshot()` every other gateway/model
// endpoint reads (apps/api/src/workspaces/routes/r4.ts) — provider-level rows
// (id, name, auth env vars, docs URL), NOT gated by workspaceLlmGatewayEnabled
// since it's meaningful for every workspace including native (non-gateway)
// ones. Workspace-read-scoped (403/404 boundary), not actually secret data.
flow(
  "WS-32",
  { domain: "workspaces", routes: ["GET /v1/workspaces/:workspaceId/llm-catalog/providers"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    await ctx.step("OWNER reads the provider-connect catalog → 200 live snapshot", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/llm-catalog/providers", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.providers").exists("$.provider_count").exists("$.model_count");
      const body = r.json<any>();
      if (!Array.isArray(body?.providers) || body.providers.length === 0) {
        throw new Error("llm-catalog/providers returned an empty provider list");
      }
    });
    await ctx.step("unknown workspace → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/llm-catalog/providers", {
          params: { workspaceId: "00000000-0000-4000-a000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/workspaces/:workspaceId/llm-catalog/providers", { params: { workspaceId: p.id } });
      r.status(403);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/workspaces/:workspaceId/llm-catalog/providers", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// WS-33 — the sandbox-provider migration poll endpoint. The PATCH prepare
// branch (switch to a non-default enabled provider) returns a kind:'preparation'
// body but does NOT flip the active provider; the client polls THIS route until
// the durable transition reaches a terminal status. Workspace-read-scoped (rejects
// cross-workspace/non-member) and shaped as a PUBLIC workspaceion — it must NEVER
// leak the lease epoch/holder, raw provider error strings, internal image names,
// or provider template ids. A fresh workspace with no transition returns
// active_provider=null + latest=null (still 200), which is the case exercised
// here without provisioning a real cross-provider build.
flow(
  "WS-33",
  { domain: "workspaces", routes: ["GET /v1/workspaces/:workspaceId/sandbox-provider/transition"] },
  async (ctx) => {
    const p = await ctx.fixtures.workspace();
    const INTERNAL_LEAK_KEYS = [
      "lease_epoch",
      "lease_holder",
      "last_error",
      "snapshot_name",
      "external_template_id",
      "attempts",
    ];
    const assertNoLeak = (item: unknown) => {
      if (item && typeof item === "object") {
        for (const k of INTERNAL_LEAK_KEYS) {
          if (k in (item as Record<string, unknown>)) {
            throw new Error(`transition view leaked internal field '${k}'`);
          }
        }
      }
    };
    await ctx.step("OWNER reads the public transition state → 200 public shape", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/sandbox-provider/transition", { params: { workspaceId: p.id } });
      r.status(200).body().exists("$.history");
      const body = r.json<{ active_provider: unknown; latest: unknown; history: unknown[] }>();
      if (!Object.prototype.hasOwnProperty.call(body, "active_provider")) {
        throw new Error("transition view omitted active_provider");
      }
      assertNoLeak(body.latest);
      if (Array.isArray(body.history)) body.history.forEach(assertNoLeak);
    });
    await ctx.step("unknown workspace → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:workspaceId/sandbox-provider/transition", {
          params: { workspaceId: "00000000-0000-4000-a000-000000000000" },
        });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404 (cross-workspace rejection)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/workspaces/:workspaceId/sandbox-provider/transition", { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/workspaces/:workspaceId/sandbox-provider/transition", { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

// WS-34 — the execution lease auth gate.
//
// The in-sandbox agent reports active OpenCode work through this route.
// Only a sandbox token can use it. A workspace principal is not sufficient.
flow(
  "WS-34",
  { domain: "workspaces", routes: ["POST /v1/workspaces/:workspaceId/execution-lease"] },
  async (ctx) => {
    const workspace = await ctx.fixtures.sharedWorkspace();
    const body = { action: "renew", session_id: "e2e-no-such-session" };
    const params = { workspaceId: workspace.id };

    await ctx.step("ANON → 401", async () => {
      const response = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/workspaces/:workspaceId/execution-lease", body, { params });
      response.status(401);
    });

    await ctx.step("OWNER user session is not a sandbox token → 403", async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:workspaceId/execution-lease", body, { params });
      response.status(403);
    });

    await ctx.step("account PAT is not a sandbox token → 403", async () => {
      const response = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post("/v1/workspaces/:workspaceId/execution-lease", body, { params });
      response.status(403);
    });

    await ctx.step("unknown action → 400 before the token check", async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:workspaceId/execution-lease",
          { action: "steal", session_id: "e2e-no-such-session" },
          { params },
        );
      response.status(400);
    });
  },
);
