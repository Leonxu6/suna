/**
 * 01 — do ALL my workspaces come back from `workspaces.list()`?
 * Compare the output against the web UI at localhost:3000.
 *
 * Run (from packages/sdk):  bun run playground/workspaces/01-list-workspaces.ts
 */
import { makeKortix, run } from "../_shared";

run("list-workspaces", async () => {
  const kortix = makeKortix();
  const workspaces = await kortix.workspaces.list();

  console.log(`✓ workspaces.list() returned ${workspaces.length} workspace(s):\n`);
  for (const p of workspaces) {
    console.log(`  ${p.name}`);
    console.log(`    id:   ${p.workspace_id}`);
    console.log(`    repo: ${p.repo_url ?? "—"}\n`);
  }

  if (workspaces.length > 0) {
    console.log("pin one for the other scripts:");
    console.log(`  export KORTIX_WORKSPACE_ID=${workspaces[0]!.workspace_id}`);
  }
});
