/**
 * 01 — List workspaces with a Kortix PAT.
 *
 * Shows the minimum viable client: `createKortix` + a static bearer token
 * (a `kortix_pat_...` Personal Access Token, minted from the Kortix dashboard
 * or `kortix.accounts.tokens.create()` — see 06-files-and-secrets.ts). No
 * Supabase session, no browser — this is the shape a CLI, cron job, or
 * server-side script uses.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *     bun run examples/01-list-workspaces.ts
 *
 * As an npm consumer (outside this monorepo) the only import line changes:
 *   import { createKortix } from '@kortix/sdk';
 * This file imports from '../src/index' instead, so `tsc`/`bun` resolve it
 * against the package's own source without a published build (see
 * examples/tsconfig.json).
 */
import { createKortix } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    console.error('Set KORTIX_API_KEY to a kortix_pat_... token and re-run.');
    process.exit(1);
  }

  const kortix = createKortix({
    backendUrl,
    getToken: async () => apiKey,
  });

  const workspaces = await kortix.workspaces.list();
  console.log(`${workspaces.length} workspace(s) reachable with this token:\n`);
  for (const p of workspaces) {
    console.log(`  ${p.workspace_id}  ${p.name}`);
  }

  if (workspaces[0]) {
    const detail = await kortix.workspace(workspaces[0].workspace_id).detail();
    console.log(
      `\nFirst workspace's detail: ${detail.config.agents.length} agent(s), ${detail.file_count} file(s)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
