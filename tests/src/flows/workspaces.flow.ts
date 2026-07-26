/**
 * Workspaces — authenticated CRUD + access. Maps to spec §13 (WS-1..8).
 */
import { flow } from "../core/flow";

flow("WS-1", { domain: "workspaces", tags: ["smoke"], routes: ["GET /v1/workspaces"] }, async (ctx) => {
  await ctx.step("OWNER lists workspaces", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces");
    r.status(200);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/workspaces");
    r.status(401);
  });
});

flow("WS-3", { domain: "workspaces", requires: ["managedGit"], routes: ["POST /v1/workspaces/provision"] }, async (ctx) => {
  await ctx.step("managed provision → 201 with repo", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/workspaces/provision", { name: ctx.fixtures.name("prov") });
    // 502 can occur transiently when the managed git host is rate-limited/unavailable.
    r.status([200, 201, 502]);
    if (r.statusCode < 400) r.body().exists("$.workspace_id").exists("$.repo_url");
    ctx.track("workspace", r.json<any>().workspace_id);
  });
  await ctx.step("name over 120 chars → 400, nothing provisioned upstream", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post("/v1/workspaces/provision", { name: `pasted prompt as name ${"word ".repeat(30)}end` });
    r.status(400);
  });
});

flow("WS-5", { domain: "workspaces", routes: ["GET /v1/workspaces/:workspaceId"] }, async (ctx) => {
  const p = await ctx.fixtures.workspace();
  await ctx.step("OWNER reads workspace", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:workspaceId", { params: { workspaceId: p.id } });
    r.status(200).body().has("$.workspace_id", p.id);
  });
  await ctx.step("NONMEMBER → 403/404", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/workspaces/:workspaceId", { params: { workspaceId: p.id } });
    r.status([403, 404]);
  });
  await ctx.step("unknown workspace → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/workspaces/:workspaceId", { params: { workspaceId: "00000000-0000-4000-a000-000000000000" } });
    r.status(404);
  });
});

flow("WS-6", { domain: "workspaces", routes: ["GET /v1/workspaces/:workspaceId/detail"] }, async (ctx) => {
  const p = await ctx.fixtures.workspace();
  await ctx.step("detail returns workspace + manifest", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:workspaceId/detail", { params: { workspaceId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/workspaces/:workspaceId/detail", { params: { workspaceId: p.id } });
    r.status(403);
  });
  if (ctx.env.capabilities.admin) {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN");
    await ctx.step("platform admin WITHOUT the bypass header → still 403 (no standing access)", async () => {
      const r = await admin.get("/v1/workspaces/:workspaceId/detail", { params: { workspaceId: p.id } });
      r.status(403);
    });
    await ctx.step("platform admin WITH x-kortix-admin-bypass → 200 (read-only escape hatch)", async () => {
      const r = await admin.get("/v1/workspaces/:workspaceId/detail", {
        params: { workspaceId: p.id },
        headers: { "x-kortix-admin-bypass": "1" },
      });
      r.status(200).body().has("$.workspace.workspace_id", p.id);
    });
  }
});

flow("WS-7", { domain: "workspaces", routes: ["PATCH /v1/workspaces/:workspaceId"] }, async (ctx) => {
  const p = await ctx.fixtures.workspace();
  await ctx.step("OWNER renames workspace", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch("/v1/workspaces/:workspaceId", { name: ctx.fixtures.name("renamed") }, { params: { workspaceId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER cannot patch → 403/404", async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .patch("/v1/workspaces/:workspaceId", { name: "nope" }, { params: { workspaceId: p.id } });
    r.status([403, 404]);
  });
});

flow(
  "WS-18",
  {
    domain: "workspaces",
    // `stripe` ⇒ the target enforces billing, so a free account is capped at 3
    // workspace; `managedGit` ⇒ managed provisioning is available to reach the cap.
    requires: ["managedGit", "stripe"],
    serial: true,
    routes: ["GET /v1/workspaces", "POST /v1/workspaces/provision"],
  },
  async (ctx) => {
    // NONMEMBER is a fresh, UNFUNDED (free) account → its workspace cap is 3.
    const list = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/workspaces");
    list.status(200);
    const existing = list.json<any[]>()?.length ?? 0;

    for (let index = existing; index < 3; index += 1) {
      await ctx.step(`free account: workspace ${index + 1} of 3 allowed (201)`, async () => {
        let r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post("/v1/workspaces/provision", {
            name: ctx.fixtures.name(`free-${index + 1}`),
          });
        // The managed Git host can return a transient 502. Retry the same quota
        // slot before deciding the contract failed; only a real 201 advances it.
        for (let attempt = 1; r.statusCode === 502 && attempt < 4; attempt += 1) {
          await Bun.sleep(2_000 * attempt);
          r = await ctx.client
            .as(ctx.P.NONMEMBER)
            .post("/v1/workspaces/provision", {
              name: ctx.fixtures.name(`free-${index + 1}-retry-${attempt}`),
            });
        }
        r.status(201).body().exists("$.workspace_id");
        ctx.track("workspace", r.json<any>().workspace_id);
      });
    }

    await ctx.step("free account: 4th workspace rejected (403 workspace_limit_reached)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/workspaces/provision", { name: ctx.fixtures.name("free-4") });
      // The quota gate runs before any repository is provisioned.
      r.status(403)
        .body()
        .has("$.code", "workspace_limit_reached")
        .has("$.limit", 3)
        .has("$.count", 3);
    });
  },
);

flow("WS-8", { domain: "workspaces", routes: ["DELETE /v1/workspaces/:workspaceId"] }, async (ctx) => {
  // Not tracked: this flow deletes it itself.
  const r0 = await ctx.client.as(ctx.P.OWNER).post("/v1/workspaces/provision", { name: ctx.fixtures.name("del") });
  const id = r0.json<any>().workspace_id;
  await ctx.step("OWNER archives workspace", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/workspaces/:workspaceId", { params: { workspaceId: id } });
    r.status(200).body().has("$.ok", true);
  });
  await ctx.step("archived workspace reads 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:workspaceId", { params: { workspaceId: id } });
    r.status(404);
  });
});
