import { WORKSPACE_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import {
  archiveRepoSubtree,
  getBranchDiff,
  getCommit,
  getCommitDiff,
  getFileHistory,
  grepRepoFiles,
  listBranches,
  listCommits,
  listRepoFiles,
  loadWorkspaceConfig,
  readRepoFile,
  searchRepoFileNames,
} from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { workspaces } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { assertWorkspaceCapability, loadWorkspaceForUser, workspaceCapabilityAllowed } from '../lib/access';
import { applyDetailCapabilityFilter } from '../lib/detail-capability-filter';
import { denierFromConfig, filterConfigResourcesForUser, resourceDenierForRequest } from '../lib/workspace-resources';
import { AnyObject, CommitSchema, WorkspaceSchema, workspacesApp } from '../lib/app';
import { getWorkspaceGitConnection, withWorkspaceGitAuth } from '../lib/git';
import {
  normalizeString,
  readBody,
  serializeWorkspace,
  serializeWorkspaceGitConnection,
} from '../lib/serializers';

function isMissingGitPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^fatal: path '.+' does not exist in '.+'$/m.test(message);
}

// GET /v1/workspaces/:workspaceId

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}',
    tags: ['workspaces'],
    summary: 'GET /:workspaceId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(WorkspaceSchema, 'The workspace'),
        ...errors(404),
    },
  }),
  async (c) => {
  const workspaceId = c.req.param('workspaceId');

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  await db
    .update(workspaces)
    .set({ lastOpenedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaces.workspaceId, workspaceId));

  return c.json(serializeWorkspace(loaded.row, {
    workspaceRole: loaded.workspaceRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// GET /v1/workspaces/:workspaceId/detail

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/detail',
    tags: ['workspaces'],
    summary: 'GET /:workspaceId/detail',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(WorkspaceSchema, 'Workspace detail'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const gitWorkspace = await withWorkspaceGitAuth(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitWorkspace, loaded.row.defaultBranch);
  } catch (error) {
    console.warn('[workspaces] repo detail listing unavailable', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  const rawConfig = await loadWorkspaceConfig(gitWorkspace, files);
  // Per-resource scoping: hide agents/skills this member isn't granted (owner/
  // admins/SAs see everything). No-op when the workspace has no resource grants.
  const denierCtx = {
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    workspaceId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
  };
  const config = await filterConfigResourcesForUser(rawConfig, denierCtx);
  // …and hide the raw FILES of those resources from the file list (visibility
  // isolation). Reuses the config already loaded — no extra git round-trip.
  const denier = await denierFromConfig(rawConfig, denierCtx);
  const visibleFiles = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
  // Per-CAPABILITY filtering (distinct from the per-resource grants above): the
  // /detail bundle serves several read surfaces behind ONE workspace.read floor, so
  // gate each section on its own leaf. A plain `member` keeps the config sections
  // it can read but NOT the file list (member lacks workspace.file.read), and a
  // custom role that unchecks e.g. workspace.skill.read gets an empty skills
  // section — all WITHOUT 403-ing the whole workspace load (which loadWorkspaceForUser
  // deliberately gates only on workspace.read so the shell renders for every member).
  const [canFiles, canAgents, canSkills, canCommands, canCustomize] = await Promise.all([
    workspaceCapabilityAllowed(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_FILE_READ),
    workspaceCapabilityAllowed(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_AGENT_READ),
    workspaceCapabilityAllowed(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SKILL_READ),
    workspaceCapabilityAllowed(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_COMMAND_READ),
    workspaceCapabilityAllowed(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_READ),
  ]);
  const gated = applyDetailCapabilityFilter(config, visibleFiles, {
    canFiles,
    canAgents,
    canSkills,
    canCommands,
    canCustomize,
  });
  return c.json({
    workspace: serializeWorkspace(loaded.row, {
      workspaceRole: loaded.workspaceRole,
      effectiveRole: loaded.effectiveRole,
    }),
    git_connection: serializeWorkspaceGitConnection(await getWorkspaceGitConnection(workspaceId)),
    config: gated.config,
    file_count: gated.file_count,
    files: gated.files,
  });
},
);

// GET /v1/workspaces/:workspaceId/files

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/files',
    tags: ['files'],
    summary: 'GET /:workspaceId/files',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_FILE_READ);

  const gitWorkspace = await withWorkspaceGitAuth(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitWorkspace, c.req.query('ref') || loaded.row.defaultBranch, c.req.query('path'));
  } catch (error) {
    console.warn('[workspaces] repo file listing unavailable', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  // Visibility isolation: drop files of agents/skills this member is scoped out
  // of. No-op (one memo check) when the workspace scopes nothing.
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    workspaceId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  const visible = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
  return c.json(visible.slice(0, 1000));
},
);

// GET /v1/workspaces/:workspaceId/files/archive?path=...&ref=...
// Streams a zip archive of the repo (or a subtree) at the given ref.

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/files/archive',
    tags: ['files'],
    summary: 'GET /:workspaceId/files/archive',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: { description: 'Binary archive', content: { 'application/octet-stream': { schema: z.any() } } },
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_FILE_READ);

  const path = normalizeString(c.req.query('path'));
  const ref = c.req.query('ref') || loaded.row.defaultBranch;

  // Visibility isolation: a zip can't be stripped mid-stream, so refuse any
  // archive whose subtree would include an agent/skill this member is scoped out
  // of (e.g. the whole repo, or `.opencode/`). They can still archive a narrower
  // path that contains none. No-op when nothing is scoped.
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    workspaceId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  if (denier?.containsDenied(path ?? '')) {
    return c.json(
      { error: 'This folder includes agents or skills you are not allowed to access. Archive a more specific path instead.' },
      403,
    );
  }

  try {
    const stream = await archiveRepoSubtree(await withWorkspaceGitAuth(loaded.row), ref, path);
    const fileName = (path?.split('/').filter(Boolean).pop() || 'workspace') + '.zip';
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to archive directory';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/workspaces/:workspaceId/files/content?path=...

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/files/search',
    tags: ['files'],
    summary: 'GET /:workspaceId/files/search',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const query = normalizeString(c.req.query('q'));
  if (!query) return c.json({ error: 'q query param is required' }, 400);

  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_FILE_READ);

  const contentSearch = c.req.query('content') === '1';
  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);

  try {
    const gitWorkspace = await withWorkspaceGitAuth(loaded.row);
    // Visibility isolation: never surface (path or content) a scoped-out
    // agent/skill in search results. One memo check when nothing is scoped.
    const denier = await resourceDenierForRequest({
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      workspaceId,
      actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
      row: loaded.row,
    });
    if (contentSearch) {
      const matches = await grepRepoFiles(gitWorkspace, query, ref, limit);
      const results = denier ? matches.filter((m) => !denier.isDenied(m.path)) : matches;
      return c.json({ query, ref, content_search: true, results });
    }
    const files = await searchRepoFileNames(gitWorkspace, query, ref, limit);
    const visible = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
    return c.json({
      query,
      ref,
      content_search: false,
      results: visible.map((f) => ({ path: f.path })),
    });
  } catch (error) {
    console.warn('[workspaces] file search unavailable', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ query, ref, content_search: contentSearch, results: [] });
  }
},
);


workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/files/content',
    tags: ['files'],
    summary: 'GET /:workspaceId/files/content',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: { description: 'OK', content: { 'application/octet-stream': { schema: z.any() } } },
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_FILE_READ);

  // Visibility isolation: a scoped-out member can't read the raw file of an
  // agent/skill they aren't granted — return the same 404 as a missing file so
  // the path isn't even confirmed to exist.
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    workspaceId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  if (denier?.isDenied(path)) return c.json({ error: 'File not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  try {
    const content = await readRepoFile(await withWorkspaceGitAuth(loaded.row), path, ref);
    return c.json({ path, ref, content });
  } catch (error) {
    if (isMissingGitPathError(error)) {
      return c.json({ error: 'File not found' }, 404);
    }
    throw error;
  }
},
);

// GET /v1/workspaces/:workspaceId/files/history?path=...&ref=...&limit=...&skip=...

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/files/history',
    tags: ['files'],
    summary: 'GET /:workspaceId/files/history',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_FILE_READ);

  // Visibility isolation: a scoped-out member can't read the commit history of
  // an agent/skill they aren't granted — return the same 404 as a missing file
  // so the path isn't confirmed to exist. Mirrors files/content (r5.ts:477-484).
  // See F-5 (weekly pentest run #4).
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    workspaceId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  if (denier?.isDenied(path)) return c.json({ error: 'File not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const limit = Number(c.req.query('limit') || '50');
  const skip = Number(c.req.query('skip') || '0');
  try {
    const result = await getFileHistory(await withWorkspaceGitAuth(loaded.row), path, { ref, limit, skip });
    return c.json({ path, ref, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load history';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/workspaces/:workspaceId/branches

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/branches',
    tags: ['files'],
    summary: 'GET /:workspaceId/branches',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ);

  try {
    const branches = await listBranches(await withWorkspaceGitAuth(loaded.row));
    return c.json({
      default_branch: loaded.row.defaultBranch,
      branches,
    });
  } catch (error) {
    console.warn('[workspaces] branch listing unavailable', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
    return c.json({ default_branch: loaded.row.defaultBranch, branches: [] });
  }
},
);

// GET /v1/workspaces/:workspaceId/commits?ref=...&path=...&limit=...&skip=...

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/commits',
    tags: ['files'],
    summary: 'GET /:workspaceId/commits',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.array(CommitSchema), 'Commits'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const path = normalizeString(c.req.query('path'));
  const limit = Number(c.req.query('limit') || '50');
  const skip = Number(c.req.query('skip') || '0');
  try {
    const result = await listCommits(await withWorkspaceGitAuth(loaded.row), { ref, path, limit, skip });
    return c.json({ ref, path: path ?? null, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load commits';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/workspaces/:workspaceId/commits/:sha

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/commits/{sha}',
    tags: ['files'],
    summary: 'GET /:workspaceId/commits/:sha',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sha: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const sha = c.req.param('sha');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ);

  try {
    const commit = await getCommit(await withWorkspaceGitAuth(loaded.row), sha);
    if (!commit) return c.json({ error: 'Commit not found' }, 404);
    return c.json(commit);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load commit';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/workspaces/:workspaceId/commits/:sha/diff?path=...

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/commits/{sha}/diff',
    tags: ['files'],
    summary: 'GET /:workspaceId/commits/:sha/diff',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sha: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const sha = c.req.param('sha');
  const path = normalizeString(c.req.query('path'));
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ);

  try {
    const diff = await getCommitDiff(await withWorkspaceGitAuth(loaded.row), sha, { path });
    return c.json({ path: path ?? null, ...diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load diff';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/workspaces/:workspaceId/version-diff?from=<ref>&into=<ref>
// Lightweight preview used by the "Open change request" dialog so the user
// can see whether there's anything to merge BEFORE creating the CR. Returns
// a summary (no patch body) so the dialog can show "X files changed, +Y -Z"
// live and gate the submit button.

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/version-diff',
    tags: ['files'],
    summary: 'GET /:workspaceId/version-diff',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const fromRef = normalizeString(c.req.query('from') ?? c.req.query('head'));
  const intoRef = normalizeString(c.req.query('into') ?? c.req.query('base'));
  if (!fromRef || !intoRef) {
    return c.json({ error: 'from and into query params are required' }, 400);
  }
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ);

  if (fromRef === intoRef) {
    return c.json({
      from: fromRef,
      into: intoRef,
      from_sha: null,
      into_sha: null,
      merge_base: null,
      files_changed: 0,
      additions: 0,
      deletions: 0,
      is_up_to_date: true,
      is_same_ref: true,
    });
  }

  try {
    const diff = await getBranchDiff(await withWorkspaceGitAuth(loaded.row), intoRef, fromRef);
    return c.json({
      from: fromRef,
      into: intoRef,
      from_sha: diff.head_sha,
      into_sha: diff.base_sha,
      merge_base: diff.merge_base,
      files_changed: diff.files_changed,
      additions: diff.additions,
      deletions: diff.deletions,
      is_up_to_date: diff.head_sha === diff.base_sha,
      is_same_ref: false,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to compute diff preview',
    }, 400);
  }
},
);

// PATCH /v1/workspaces/:workspaceId

workspacesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{workspaceId}',
    tags: ['workspaces'],
    summary: 'PATCH /:workspaceId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(WorkspaceSchema, 'The updated workspace'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Editing workspace config (name / default_branch / manifest_path) is a
  // customize-write capability. manifest_path is especially sensitive: it
  // selects which kortix.yaml drives per-agent env scoping, so a custom role
  // can withhold it and a scoped agent must hold it (central fold).
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);

  const updates: Partial<typeof workspaces.$inferInsert> = { updatedAt: new Date() };
  const name = normalizeString(body.name);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath);

  if (name) updates.name = name;
  if (defaultBranch) updates.defaultBranch = defaultBranch;
  if (manifestPath) updates.manifestPath = manifestPath;

  const [row] = await db
    .update(workspaces)
    .set(updates)
    .where(eq(workspaces.workspaceId, workspaceId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeWorkspace(row, {
    workspaceRole: loaded.workspaceRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// PATCH /v1/workspaces/:workspaceId/onboarding
// Persist whether the workspace's guided onboarding wizard has been completed
// (or explicitly skipped). Stored in `metadata.onboarding_completed_at` so we
// avoid a schema migration — the workspaces.metadata jsonb already exists and
// is already exposed by serializeWorkspace. Workspace-wide state (not per-user).
