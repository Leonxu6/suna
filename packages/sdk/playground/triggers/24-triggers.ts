/**
 * 24 — triggers (cron / event automations): list what the workspace has.
 * Read-only — create/fire/remove mutate workspace automation, run those
 * deliberately.
 *
 * Run (from packages/sdk):  bun run playground/triggers/24-triggers.ts [workspaceId]
 */
import { makeKortix, pickWorkspaceId, run } from "../_shared";

run("triggers", async () => {
  const kortix = makeKortix();
  const workspaceId = await pickWorkspaceId(kortix, process.argv[2]);

  const triggers = await kortix.workspace(workspaceId).triggers.list();
  console.log(`✓ triggers.list(): ${JSON.stringify(triggers).slice(0, 400)}…`);
});
