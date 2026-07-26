/**
 * 02 — given a workspace, can I read its sessions?
 * Workspace selection: argv[2] → KORTIX_WORKSPACE_ID → first workspace.
 *
 * Run (from packages/sdk):  bun run playground/sessions/02-list-sessions.ts [workspaceId]
 */
import { makeKortix, pickWorkspaceId, run } from "../_shared";

run("list-sessions", async () => {
  const kortix = makeKortix();
  const workspaceId = await pickWorkspaceId(kortix, process.argv[2]);

  const sessions = await kortix.workspaces.sessions(workspaceId);

  console.log(
    `✓ workspaces.sessions(${workspaceId}) returned ${sessions.length} session(s):\n`,
  );
  for (const s of sessions) {
    console.log(`  ${s.name ?? s.branch_name}`);
    console.log(`    id:     ${s.session_id}`);
    console.log(`    status: ${s.status}`);
    console.log(`    agent:  ${s.agent_name ?? "—"}\n`);
  }

  if (sessions.length > 0) {
    console.log("pin one for the chat scripts:");
    console.log(`  export KORTIX_SESSION_ID=${sessions[0]!.session_id}`);
  }
});
