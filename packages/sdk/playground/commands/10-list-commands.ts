/**
 * 10 — list the workspace's slash commands.
 *
 * Commands are markdown prompt templates the runtime accepts at
 * `<opencode>/commands/<slug>.md` (`.kortix/opencode/commands/` here). The
 * platform surfaces repo-registered ones via `workspaces.detail().config`.
 *
 * Run (from packages/sdk):  bun run playground/commands/10-list-commands.ts [workspaceId]
 */
import { makeKortix, pickWorkspaceId, run } from "../_shared";

run("list-commands", async () => {
  const kortix = makeKortix();
  const workspaceId = await pickWorkspaceId(kortix, process.argv[2]);

  const detail = await kortix.workspaces.detail(workspaceId);
  const commands = detail.config.commands;

  console.log(`✓ ${commands.length} command(s):\n`);
  for (const command of commands) {
    console.log(`  /${command.name}`);
    console.log(`    path: ${command.path}`);
    if (command.description)
      console.log(`    desc: ${command.description.slice(0, 100)}`);
    console.log("");
  }

  if (commands.length === 0) {
    console.log(
      "  (none registered in the repo — 11-create-command writes one into a",
    );
    console.log(
      "   session workspace; it appears here once that change is committed)",
    );
  }
});
