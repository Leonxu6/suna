/**
 * 20 — access control: workspace members, pending invites, access requests,
 * per-resource grants, and workspace policies. All reads.
 *
 * Run (from packages/sdk):  bun run playground/access/20-access-and-policies.ts [workspaceId]
 */
import { makeKortix, pickWorkspaceId, run } from "../_shared";

run("access-and-policies", async () => {
  const kortix = makeKortix();
  const workspaceId = await pickWorkspaceId(kortix, process.argv[2]);
  const workspace = kortix.workspace(workspaceId);

  const access = await workspace.access.list();
  console.log(`✓ access.list(): ${JSON.stringify(access).slice(0, 300)}…`);

  const invites = await workspace.access.pendingInvites();
  console.log(`✓ pendingInvites(): ${JSON.stringify(invites).slice(0, 200)}`);

  const requests = await workspace.access.requests();
  console.log(`✓ requests(): ${JSON.stringify(requests).slice(0, 200)}`);

  const grants = await workspace.access.resourceGrants.list();
  console.log(
    `✓ resourceGrants.list(): ${JSON.stringify(grants).slice(0, 200)}`,
  );

  const policies = await workspace.policies.list();
  console.log(`✓ policies.list(): ${JSON.stringify(policies).slice(0, 250)}…`);
});
