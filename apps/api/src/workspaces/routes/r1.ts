import { ACCOUNT_ACTIONS, WORKSPACE_ACTIONS, assertAuthorized, authorize, listAccessibleResources } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { kickWorkspaceTemplatePrebuilds } from '../../snapshots/builder';
import { isAccountManager, type WorkspaceRole } from '../access';
import { getBackend, hasBackend, managedGithubOwner, managedGithubToken, parseBasicAuthHeader, type GitScope } from '../git-backends';
import { seedRepoViaGitPush } from '../git-backends/seed';
import {
  getGitHubAppInstallation,
  listLinkableGitHubAppInstallations,
  type GitHubAppInstallation,
  verifyGitHubAppInstallStatePayload,
  verifyGitHubInstallationAdmin,
} from '../github';
import { getWorkspaceSecretValue } from '../secrets';
import { normalizeStarterTemplateId } from '../starter';
import {
  buildWorkspaceSeedFiles,
  buildWorkspaceSeedFilesFromItem,
  defaultAgentFromSeedFiles,
  normalizeMarketplaceItems,
} from '../seed-files';
import { getCatalogItemDetail } from '../../marketplace/catalog';
import { loadWorkspaceTriggers } from '../triggers';
import { invalidateWorkspaceMirror } from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGithubInstallations, accounts, workspaceMembers, workspaces } from '@kortix/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { enforceWorkspaceQuota, grantWorkspaceRole, loadWorkspaceForUser, resolveWorkspaceAccount, assertWorkspaceCapability } from '../lib/access';
import { AnyObject, WorkspaceSchema, workspaceWebhooksApp, workspacesApp } from '../lib/app';
import { GitHubInstallationRequiredError, buildConnectionRef, consumeGitHubInstallationState, createGitHubInstallationInstallUrl, getAccountGitHubInstallation, getWorkspaceGitConnection, getWorkspaceGitRemote, listAccountGitHubInstallations, resolveGitHubImport, resolveWorkspaceGitAuth, resolveWorkspaceUpstream, upsertWorkspaceGitConnection, withWorkspaceGitAuth } from '../lib/git';
import { metadataMerge } from '../lib/metadata-merge';
import { registerGitHubLinkedWorkspace } from '../lib/workspace-registration';
import { WORKSPACE_NAME_MAX_LENGTH, UUID_V4_REGEX, deriveWorkspaceName, normalizeRepoUrl, normalizeString, readBody, requestAuditContext, serializeGitHubInstallation, serializeGitHubInstallations, serializeWorkspace } from '../lib/serializers';
import { extractWebhookToken, fireGitTrigger, markGitTriggerFired, renderPromptTemplate, triggerFilterMatches, triggersPausedForWorkspace, verifyWebhookSignature, verifyWebhookToken, webhookPayload } from '../lib/triggers';
import {
  consumeWorkspaceWebhookManifestRefreshBudget,
  createWorkspaceWebhookRateLimitMiddleware,
} from '../../shared/rate-limit';

workspacesApp.use('/*', supabaseAuth);

workspaceWebhooksApp.use('/workspaces/:workspaceId/:slug', createWorkspaceWebhookRateLimitMiddleware());

workspaceWebhooksApp.post('/workspaces/:workspaceId/:slug', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const slug = c.req.param('slug');
  if (!UUID_V4_REGEX.test(workspaceId)) return c.json({ error: 'Invalid workspace id' }, 400);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid trigger slug' }, 400);
  }

  const hasCredentialHeader = Boolean(
    c.req.header('x-kortix-signature') ||
      c.req.header('x-hub-signature-256') ||
      c.req.header('x-kortix-token') ||
      c.req.header('authorization'),
  );
  if (!hasCredentialHeader) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(
      eq(workspaces.workspaceId, workspaceId),
      eq(workspaces.status, 'active'),
    ))
    .limit(1);
  if (!workspace) return c.json({ error: 'Not found' }, 404);

  // Trigger CRUD can commit on another API replica. Refresh this replica's
  // mirror before authentication, but bound the unauthenticated Git work by
  // workspace. Rotating source IPs cannot force more than one refresh per 30s.
  if (consumeWorkspaceWebhookManifestRefreshBudget(workspaceId)) {
    invalidateWorkspaceMirror(workspaceId);
  }
  const { specs } = await loadWorkspaceTriggers(await withWorkspaceGitAuth(workspace));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec || spec.type !== 'webhook' || !spec.enabled) {
    return c.json({ error: 'Not found' }, 404);
  }

  const rawBody = await c.req.text();
  const secret = spec.secretEnv
    ? await getWorkspaceSecretValue(workspace.workspaceId, spec.secretEnv)
    : null;
  if (!secret) {
    return c.json({ error: 'Webhook secret is not configured' }, 409);
  }

  // Primary auth: HMAC-SHA256 signature over the raw body (GitHub-compatible).
  // Fallback, ONLY when no signature header is present: a static shared token in
  // X-Kortix-Token or Authorization, for sources that can't HMAC-sign their body
  // (e.g. Better Stack error webhooks — custom headers / basic auth only). Both
  // paths require knowing the trigger's secret, so security is equivalent to a
  // shared bearer token; signed senders are unaffected.
  const signatureHeader =
    c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
  const authed = signatureHeader
    ? verifyWebhookSignature(rawBody, secret, signatureHeader)
    : verifyWebhookToken(
        extractWebhookToken(c.req.header('x-kortix-token'), c.req.header('authorization')),
        secret,
      );
  if (!authed) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  (c as any).set('accountId', workspace.accountId);

  const payload = {
    ...webhookPayload(c, rawBody),
    trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
    fired_at: new Date().toISOString(),
  };
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);
  const deliveryId =
    c.req.header('x-kortix-delivery-id') ??
    c.req.header('x-github-delivery') ??
    c.req.header('x-request-id') ??
    null;
  const staticAuthFingerprint =
    c.req.header('x-kortix-token') ??
    c.req.header('authorization') ??
    '';
  const idempotencyKey = deliveryId
    ? `trigger:webhook:${workspace.workspaceId}:${spec.slug}:${deliveryId}`
    : `trigger:webhook:${workspace.workspaceId}:${spec.slug}:${createHash('sha256')
        .update(rawBody)
        .update(signatureHeader ?? '')
        .update(staticAuthFingerprint)
        .digest('hex')}`;

  // Server-side per-workspace kill-switch: a paused workspace ignores inbound
  // webhooks (acknowledged, not fired) so a repo deployed to two control planes
  // doesn't double-fire. Manual `…/fire` is unaffected. See triggersPausedForWorkspace.
  if (triggersPausedForWorkspace(workspace.metadata)) {
    return c.json({ status: 'skipped', reason: 'triggers are paused server-side for this workspace' }, 200);
  }

  // Payload guard. A non-matching delivery is a successful no-op, NOT an error:
  // the sender is behaving correctly and must not see a 4xx it would retry. The
  // canonical use is loop-breaking — a source that reports both directions of a
  // conversation would otherwise re-fire the agent with the agent's own reply.
  if (!triggerFilterMatches(spec, payload)) {
    return c.json({ status: 'skipped', reason: 'delivery did not match the trigger filter' }, 200);
  }

  const result = await fireGitTrigger({
    spec,
    workspace,
    payload,
    renderedPrompt,
    source: 'webhook',
    idempotencyKey,
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    await markGitTriggerFired(workspace.workspaceId, spec.slug, new Date());
    return c.json({
      status: 'queued',
      command_id: result.commandId ?? null,
      session_id: result.sessionId ?? null,
      reason: result.reason ?? null,
      deduped: result.deduped ?? false,
    }, 202);
  }
  if (result.status === 'failed') {
    return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
  }
  // Stamp runtime last_fired_at so the UI's "last fired N ago" matches the
  // cron-fire path even when the webhook is the actual source.
  await markGitTriggerFired(workspace.workspaceId, spec.slug, new Date());
  return c.json({
    status: result.deduped ? 'deduped' : 'fired',
    command_id: result.commandId ?? null,
    session_id: result.sessionId ?? null,
    deduped: result.deduped ?? false,
  }, 202);
});


workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['workspaces'],
    summary: 'GET /',
    ...auth,
    responses: {
        200: json(z.array(WorkspaceSchema), 'Workspaces the caller can read'),
    },
  }),
  async (c) => {
  const scope = await resolveWorkspaceAccount(c);
  // Reach through `any` for non-typed context keys set by the auth
  // middleware (the AppEnv only types userId/userEmail).
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;
  const requestCtx = deriveRequestContext(c);

  // Ask the IAM engine which workspaces the caller can READ. V2 returns
  // one of: { mode: 'all' } | { mode: 'none' } | { mode: 'allow_only' }.
  // 'all' = account admin/owner (manager on every workspace); 'allow_only'
  // = enumerated workspace IDs from direct workspace_members + group grants;
  // 'none' = no access.
  const accessible = await listAccessibleResources(
    scope.userId,
    scope.accountId,
    'workspace.read',
    'workspace',
    actingTokenId,
    requestCtx,
  );

  if (accessible.mode === 'none') return c.json([]);

  // Build the workspace rows + per-row workspace_members metadata used by
  // the UI to label effective_role. We still consult workspace_members
  // because the IAM engine bridges it into authorize() but doesn't
  // hand the per-row role back here — and the UI wants the original
  // manager/editor/viewer label, not just "allowed".
  const grants = await db
    .select({ workspaceId: workspaceMembers.workspaceId, workspaceRole: workspaceMembers.workspaceRole })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.accountId, scope.accountId),
      eq(workspaceMembers.userId, scope.userId),
    ));
  const roleByWorkspace = new Map(
    grants.map((g) => [g.workspaceId, g.workspaceRole as WorkspaceRole]),
  );

  const baseWhere = and(
    eq(workspaces.accountId, scope.accountId),
    eq(workspaces.status, 'active'),
  );

  let rows: Array<typeof workspaces.$inferSelect>;
  if (accessible.mode === 'all') {
    rows = await db.select().from(workspaces).where(baseWhere).orderBy(desc(workspaces.updatedAt));
  } else {
    // mode === 'allow_only'. The 'none' case was returned above.
    if (accessible.allowed.size === 0) return c.json([]);
    rows = await db
      .select()
      .from(workspaces)
      .where(and(baseWhere, inArray(workspaces.workspaceId, [...accessible.allowed])))
      .orderBy(desc(workspaces.updatedAt));
  }

  // Heuristic for effective_role label (UI only, NOT auth):
  //   - account-manager → 'manager' (legacy owner/admin gets full label)
  //   - explicit workspace_members row → that role
  //   - otherwise → 'member' (engine allowed read but we don't know the
  //     exact role; safe minimum for UI affordances)
  const accountManager = isAccountManager(scope.accountRole);
  return c.json(
    rows.map((row) => {
      const workspaceRole = roleByWorkspace.get(row.workspaceId) ?? null;
      const effectiveRole = accountManager
        ? 'manager'
        : workspaceRole ?? 'member';
      return serializeWorkspace(row, { workspaceRole, effectiveRole });
    }),
  );
},
);

// POST /v1/workspaces

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['workspaces'],
    summary: 'POST /',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(WorkspaceSchema, 'The created workspace'),
        ...errors(400, 409),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveWorkspaceAccount(c, body);
  // IAM-gated. Engine consults super-admin bypass, direct + group
  // policies, and legacy owner/admin bridges (in non-strict mode).
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.WORKSPACE_CREATE);

  let repoUrl: string | null;
  try {
    repoUrl = normalizeRepoUrl(body.repo_url ?? body.repoUrl);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Invalid repo_url' }, 400);
  }
  if (!repoUrl) {
    return c.json({ error: 'repo_url is required' }, 400);
  }

  const quota = await enforceWorkspaceQuota(c, scope.accountId);
  if (quota) return quota;

  const name = normalizeString(body.name) ?? deriveWorkspaceName(repoUrl);
  const requestedBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.yaml';

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: normalizeString(body.installation_id ?? body.installationId),
      defaultBranch: requestedBranch,
    });
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
  }

  const row = await registerGitHubLinkedWorkspace({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name,
    defaultBranch: imported.defaultBranch,
    manifestPath,
  });

  kickWorkspaceTemplatePrebuilds(
    {
      workspaceId: row.workspaceId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: imported.auth.token,
    },
    { accountId: scope.accountId, source: 'workspace-create' },
  );

  return c.json(serializeWorkspace(row, { workspaceRole: 'manager', effectiveRole: 'manager' }), 201);
},
);

// GET /v1/workspaces/managed-git/status
// Lets the frontend pre-check whether the managed-git "Create workspace" path
// (POST /provision) is usable BEFORE the user hits its 503, so the create UI
// can disable/annotate that option instead of surfacing a raw server error.
// Self-host deployments with no MANAGED_GIT_* configured are the primary
// case — the BYO-repo import path (POST / and /create-repo) stays available
// regardless.
workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/managed-git/status',
    tags: ['workspaces'],
    summary: 'GET /managed-git/status',
    ...auth,
    responses: {
      200: json(
        z.object({ configured: z.boolean(), provider: z.string() }),
        'Whether the managed-git provider is configured on this server',
      ),
    },
  }),
  async (c: any) => {
    const provider = process.env.MANAGED_GIT_PROVIDER?.trim() || 'github';
    const configured = hasBackend(provider) && (await getBackend(provider).isConfigured());
    return c.json({ configured, provider });
  },
);

// POST /v1/workspaces/provision
// Managed-git "Create workspace": provisions a repo on the managed backend +
// scoped per-workspace push token, optionally seeds the starter (web flow), and
// registers the workspace.
// Used by the web "Create workspace" button and `kortix ship` when a working tree
// has no `origin` remote. BYO-repo workspaces go through POST / and /create-repo.

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/provision',
    tags: ['workspaces'],
    summary: 'POST /provision',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(400, 403, 502, 503),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveWorkspaceAccount(c, body);
  if (!(await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.WORKSPACE_CREATE)).allowed) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  // Managed-git provider, provider-agnostic via the backend registry. GitHub is
  // the default + only active managed backend. Forgejo / Artifacts slot in here
  // as drop-ins.
  const provider =
    normalizeString(body.provider) ??
    (process.env.MANAGED_GIT_PROVIDER?.trim() || 'github');
  if (!hasBackend(provider)) {
    return c.json({ error: `Unsupported managed git provider "${provider}"` }, 400);
  }
  const backend = getBackend(provider);
  if (!(await backend.isConfigured())) {
    return c.json(
      { error: `Managed git provider "${provider}" is not configured on this server` },
      503,
    );
  }

  const name = normalizeString(body.name) ?? normalizeString(body.workspace_name ?? body.workspaceName);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
    return c.json(
      { error: 'name must contain only letters, numbers, spaces, hyphens, underscores or dots' },
      400,
    );
  }
  // The column is varchar(255); without this check an over-long name (users
  // paste whole task prompts here) passes the charset regex, provisions the
  // upstream repo, then dies on the DB insert — a 500 plus an orphaned managed
  // repo per retry. Reject BEFORE anything is created upstream.
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return c.json(
      { error: `name must be ${WORKSPACE_NAME_MAX_LENGTH} characters or fewer` },
      400,
    );
  }

  // "Clone workspace" — seed the new repo from a `registry:project` marketplace
  // item instead of the blank starter. Resolved + type-checked BEFORE any
  // upstream repo/DB row is created, same as the name checks above.
  const sourceItemId = normalizeString(body.source_item_id ?? body.sourceItemId);
  if (sourceItemId) {
    const sourceItem = await getCatalogItemDetail(sourceItemId);
    if (!sourceItem || sourceItem.type !== 'registry:project') {
      return c.json({ error: `Unknown or non-cloneable workspace item "${sourceItemId}"` }, 400);
    }
  }

  // Managed repo name = a readable slug from the display name + the workspace's
  // UUID, so managed repos under the shared org NEVER collide (two workspaces can
  // share a name). We generate the workspace id up front to bake it into the repo
  // name and reuse it as the workspace row id.
  const workspaceId = randomUUID();
  const baseSlug = (
    name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'kortix-workspace'
  ).slice(0, 40);
  const repoSlug = `${baseSlug}-${workspaceId}`;
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';

  // Provision always mints a brand-new managed repo, so the quota check is a
  // straight count — no repoUrl to treat as an idempotent re-link. Runs after
  // request validation but before we create anything upstream.
  const provisionQuota = await enforceWorkspaceQuota(c, scope.accountId);
  if (provisionQuota) return provisionQuota;

  let provisioned: Awaited<ReturnType<typeof backend.createRepo>>;
  try {
    provisioned = await backend.createRepo({
      accountId: scope.accountId,
      workspaceId,
      slug: repoSlug,
      defaultBranch,
      isPrivate: true,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Failed to provision managed repo' }, 502);
  }

  const authMethod = provider === 'github' ? 'github_app' : 'managed';
  const now = new Date();
  const [row] = await db
    .insert(workspaces)
    .values({
      workspaceId,
      accountId: scope.accountId,
      name,
      repoUrl: provisioned.upstreamUrl,
      defaultBranch: provisioned.defaultBranch,
      // The starter this route seeds (buildWorkspaceSeedFiles, below) ships
      // kortix.yaml (kortix_version 2) — record that as the canonical path so
      // a workspace created here is never labeled with a stale v1 filename. A
      // CLI `kortix ship` that pushes its own files instead of seeding still
      // scaffolded via `kortix init` (same @kortix/starter, same kortix.yaml),
      // so this holds for both the web and CLI creation paths.
      manifestPath: 'kortix.yaml',
      status: 'active',
      metadata: {
        git: {
          url: provisioned.upstreamUrl,
          upstream_url: provisioned.upstreamUrl,
          default_branch: provisioned.defaultBranch,
          provider,
          managed: true,
          auth: {
            method: authMethod,
            ref: provisioned.credentialRef,
            installation_id: provisioned.installationId,
          },
          repo_id: provisioned.externalRepoId,
          owner: provisioned.repoOwner,
          name: provisioned.repoName,
        },
        // MANDATORY DECLARED AGENTS (docs/specs/2026-07-05-agent-first-config-
        // unification.md §2.1/§3 Phase 2): every workspace created through this
        // route is "new" in the spec's sense — subject to declared-agent
        // enforcement from birth, regardless of the platform-wide
        // KORTIX_REQUIRE_DECLARED_AGENTS flag (see workspaceRequiresDeclaredAgents /
        // createWorkspaceSession). Pre-existing workspaces (this flag absent/false)
        // keep the v1 adopt-to-govern behavior untouched.
        require_declared_agents: true,
      },
      updatedAt: now,
    })
    .returning();

  await db
    .update(accounts)
    .set({ defaultWorkspaceId: row.workspaceId })
    .where(
      and(eq(accounts.accountId, scope.accountId), isNull(accounts.defaultWorkspaceId)),
    );

  await grantWorkspaceRole({
    accountId: scope.accountId,
    workspaceId: row.workspaceId,
    userId: scope.userId,
    role: 'manager',
    grantedBy: scope.userId,
  });
  await upsertWorkspaceGitConnection({
    accountId: scope.accountId,
    workspaceId: row.workspaceId,
    provider,
    repoUrl: provisioned.upstreamUrl,
    upstreamUrl: provisioned.upstreamUrl,
    managed: true,
    repoOwner: provisioned.repoOwner,
    repoName: provisioned.repoName,
    externalRepoId: provisioned.externalRepoId,
    defaultBranch: provisioned.defaultBranch,
    authMethod,
    installationId: provisioned.installationId,
    credentialRef: provisioned.credentialRef,
    visibility: 'private',
    status: 'connected',
    metadata: { seeded: false },
  });
  const connRef = buildConnectionRef(
    row,
    getWorkspaceGitRemote(row, await getWorkspaceGitConnection(row.workspaceId)),
  );

  // Resolve a push credential for seeding / the CLI's first push. The managed
  // GitHub backend mints an installation token.
  let internalPushToken = provisioned.initialToken;
  let exportablePushToken = provisioned.initialToken;
  if (!internalPushToken) {
    const resolved = await resolveWorkspaceGitAuth(row);
    internalPushToken = resolved.auth?.token ?? null;
    exportablePushToken = resolved.authSource === 'pat'
      ? null
      : resolved.auth?.token ?? null;
  }
  const writeUpstream = internalPushToken
    ? backend.buildUpstream(connRef, internalPushToken, 'write')
    : null;
  const exportableCredential = exportablePushToken
    ? parseBasicAuthHeader(
        backend.buildUpstream(connRef, exportablePushToken, 'write').headers.Authorization,
      )
    : null;

  // Seed the starter into the empty repo when the caller has no local working
  // tree to push (web "Create workspace"). The CLI leaves this false and pushes
  // its own files on first `kortix ship`. If seeding fails we roll back the
  // orphan repo + workspace so we never leave a half-created workspace behind.
  const seedStarter = body.seed_starter === true || body.seedStarter === true || !!sourceItemId;
  const starterTemplate = normalizeStarterTemplateId(body.starter_template ?? body.starterTemplate);
  const marketplaceItems = normalizeMarketplaceItems(body.marketplace_items ?? body.marketplaceItems);
  let seeded = false;
  if (seedStarter) {
    try {
      if (!internalPushToken) throw new Error('no push credential resolved for seeding');
      const seed = sourceItemId
        ? await buildWorkspaceSeedFilesFromItem({
            id: sourceItemId,
            workspaceName: name,
            repoFullName: repoSlug,
            extraMarketplaceItems: marketplaceItems,
            now: now.toISOString(),
          })
        : await buildWorkspaceSeedFiles({
            workspaceName: name,
            repoFullName: repoSlug,
            template: starterTemplate,
            marketplaceItems,
            now: now.toISOString(),
          });
      if (backend.seedFiles) {
        // Seed the workspace tip == the deterministic scaffold root (the constant
        // 'kortix-workspace' render), byte-identical to the image-baked scaffold
        // (snapshots/build-context.ts). This lets a fresh session's fork REUSE
        // the warm-seed's already-opencode-initialized /workspace with ZERO
        // network (git.ts baked-checkout reuse fires when baseSha == scaffold
        // root) — the single biggest spawn-latency win. The per-workspace name
        // customization is applied in-sandbox at fork (not committed to the
        // shared remote root) so the warm reuse is never broken by a divergent tip.
        await backend.seedFiles(connRef, internalPushToken, seed.files, {
          branch: provisioned.defaultBranch,
          message: 'chore: scaffold Kortix workspace',
          baseFiles: seed.baseFiles,
        });
      } else {
        await seedRepoViaGitPush({
          upstreamUrl: connRef.upstreamUrl,
          token: internalPushToken,
          files: seed.files,
          branch: provisioned.defaultBranch,
          commitMessage: 'chore: scaffold Kortix workspace',
          baseFiles: seed.baseFiles,
        });
      }
      seeded = true;

      // Mirror the seeded manifest's declared default agent into
      // workspace.metadata (see defaultAgentFromSeedFiles in ../seed-files.ts)
      // so session creation resolves it from birth instead of falling back
      // to the non-binding 'default' sentinel — see
      // llm-gateway/resolution/default-model.ts's cachedSessionAgent for the
      // defense-in-depth fallback that also covers pre-existing/CLI-created
      // workspaces where this mirror is still stale.
      const seededDefaultAgent = defaultAgentFromSeedFiles(seed.files, row.manifestPath);
      if (seededDefaultAgent) {
        row.metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}), default_agent: seededDefaultAgent };
        // FIX-J: persist ONLY `default_agent` via a SQL-side atomic merge (never
        // the whole object) so this creation-seed write can't revert a pin the
        // prebuild kick may have activated concurrently. `row.metadata` above is
        // the in-memory copy the creation response serializes.
        await db
          .update(workspaces)
          .set({ metadata: metadataMerge({ default_agent: seededDefaultAgent }), updatedAt: new Date() })
          .where(eq(workspaces.workspaceId, row.workspaceId))
          .catch(() => {}); // best-effort — a mirror-write hiccup must not fail workspace creation
      }
    } catch (error) {
      try { await backend.deleteRepo(connRef); } catch { /* best effort */ }
      await db.delete(workspaces).where(eq(workspaces.workspaceId, row.workspaceId)).catch(() => {});
      return c.json({ error: (error as Error).message || 'Failed to seed workspace repo' }, 502);
    }
  }

  if (seeded) {
    kickWorkspaceTemplatePrebuilds(
      {
        workspaceId: row.workspaceId,
        repoUrl: writeUpstream?.url ?? row.repoUrl,
        defaultBranch: row.defaultBranch,
        manifestPath: row.manifestPath,
        gitAuthToken: internalPushToken,
        gitAuthHeaders: writeUpstream?.headers ?? {},
      },
      { accountId: scope.accountId, source: 'workspace-create' },
    );
  }

  return c.json(
    {
      ...serializeWorkspace(row, { workspaceRole: 'manager', effectiveRole: 'manager' }),
      push_token: exportablePushToken,
      git_username: exportableCredential?.username ?? null,
      repo_id: provisioned.externalRepoId,
      seeded,
    },
    201,
  );
},
);

// POST /v1/workspaces/:workspaceId/git-token
// Mint a fresh scoped push token for a *managed* workspace so the CLI
// can push on a later `kortix ship` without persisting credentials in git config.
// Returns 409 for BYO workspaces (they push with the user's own git remote auth).

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/git-token',
    tags: ['github'],
    summary: 'POST /:workspaceId/git-token',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409, 503),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // This endpoint hands back a RAW git push credential. workspace.write is
  // fold-exempt, so without a leaf gate a read-scoped agent could mint a push
  // token and bypass every CR/commit gate. Gate on gitops.push: a custom role
  // can withhold it, and the agent fold requires it in the token's grant.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH);

  const connection = await getWorkspaceGitConnection(workspaceId);
  const remote = getWorkspaceGitRemote(loaded.row, connection);
  if (!remote.managed) {
    return c.json({ error: 'Workspace is not a managed repo' }, 409);
  }

  // Provider-agnostic: resolve a fresh push credential through the backend seam
  // (the managed GitHub backend mints an installation token). Never persisted
  // in the sandbox/CLI git config.
  const gitAuth = await resolveWorkspaceGitAuth(loaded.row);
  if (gitAuth.authSource === 'pat') {
    return c.json(
      { error: 'Managed git push token export requires a repo-scoped installation token' },
      503,
    );
  }
  const upstream = await resolveWorkspaceUpstream(loaded.row, 'write');
  const credential = parseBasicAuthHeader(upstream?.headers.Authorization);
  if (!credential) {
    return c.json({ error: 'Managed git is not configured / unavailable for this workspace' }, 503);
  }

  return c.json({
    push_token: credential.token,
    git_username: credential.username,
    repo_id: remote.externalRepoId,
    repo_url: upstream?.url ?? loaded.row.repoUrl,
  });
},
);

// POST /v1/workspaces/:workspaceId/git/collaborators
// Invite a GitHub user as a collaborator on a MANAGED repo — lets the workspace
// creator pull "their" Kortix-managed repo into their own GitHub account and
// work on it on github.com directly. Managed repos only (the user already owns
// BYO repos). GitHub sends a pending invite the user accepts.

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/git/collaborators',
    tags: ['github'],
    summary: 'POST /:workspaceId/git/collaborators',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409, 502),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Inviting a git collaborator grants a human standing access to the repo —
  // membership-tier, not plain write. Gate on members.manage so an editor (or a
  // scoped agent via the fold) can't add external collaborators.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE);

  const body = await readBody(c);
  const username = normalizeString(body.github_username ?? body.username ?? body.login);
  if (!username) return c.json({ error: 'github_username is required' }, 400);
  const permission = normalizeString(body.permission);
  const scope: GitScope = permission === 'read' || permission === 'pull' ? 'read' : 'write';

  const remote = getWorkspaceGitRemote(loaded.row, await getWorkspaceGitConnection(workspaceId));
  if (remote.provider !== 'github' || !remote.managed) {
    return c.json({ error: 'Collaborator invites are only available for managed GitHub repos' }, 409);
  }
  const ref = buildConnectionRef(loaded.row, remote);
  const backend = getBackend(remote.provider);
  if (!backend.inviteCollaborator) {
    return c.json({ error: 'This git backend does not support collaborator invites' }, 400);
  }

  try {
    const result = await backend.inviteCollaborator(ref, username, scope);
    return c.json(result);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Failed to invite collaborator' }, 502);
  }
},
);

// GET /v1/workspaces/github/installation?account_id=...
// Account-scoped GitHub App install state. The client only receives metadata;
// installation tokens are minted server-side at repo creation time.

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/installation',
    tags: ['github'],
    summary: 'GET /github/installation',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveWorkspaceAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.WORKSPACE_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  // No account-level GitHub App installation, but the server has a working
  // managed-git PAT ("Use a token" self-host setup) — fall back to it so this
  // account isn't told "GitHub isn't connected" just because it never
  // installed an App (see serializeGitHubInstallations).
  const patFallbackOwner =
    rows.length === 0 && managedGithubToken() && (await isPlatformAdmin(scope.userId))
      ? managedGithubOwner()
      : null;
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl, patFallbackOwner));
},
);

// GET /v1/workspaces/github/installations?account_id=...
// Vercel-style account Git connections surface. A Kortix account can connect
// multiple GitHub users/orgs and pick the exact installation during import.

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/github/installations',
    tags: ['github'],
    summary: 'GET /github/installations',
    ...auth,
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveWorkspaceAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.WORKSPACE_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  // No account-level GitHub App installation, but the server has a working
  // managed-git PAT ("Use a token" self-host setup) — fall back to it so this
  // account isn't told "GitHub isn't connected" just because it never
  // installed an App (see serializeGitHubInstallations).
  const patFallbackOwner =
    rows.length === 0 && managedGithubToken() && (await isPlatformAdmin(scope.userId))
      ? managedGithubOwner()
      : null;
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl, patFallbackOwner));
},
);

async function upsertAccountGitHubInstallation(
  accountId: string,
  installationId: string,
  installation: GitHubAppInstallation,
) {
  const ownerLogin = normalizeString(installation.account?.login);
  if (!ownerLogin) {
    throw new Error('GitHub installation did not include an owner account');
  }

  const ownerType =
    normalizeString(installation.account?.type) ?? installation.target_type ?? 'Organization';
  const now = new Date();
  const [row] = await db
    .insert(accountGithubInstallations)
    .values({
      accountId,
      installationId,
      ownerLogin,
      ownerType,
      repositorySelection: installation.repository_selection ?? null,
      permissions: installation.permissions ?? {},
      metadata: {
        html_url: installation.html_url ?? null,
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountGithubInstallations.accountId, accountGithubInstallations.installationId],
      set: {
        ownerLogin,
        ownerType,
        repositorySelection: installation.repository_selection ?? null,
        permissions: installation.permissions ?? {},
        metadata: {
          html_url: installation.html_url ?? null,
        },
        updatedAt: now,
      },
    })
    .returning();

  if (!row) throw new Error('Failed to save the GitHub installation');
  return row;
}

// POST /v1/workspaces/github/installations/linkable
// The GitHub OAuth token cannot call GET /user/installations. GitHub restricts
// that route to GitHub App user tokens. Kortix lists this App's installations
// with the App JWT, then filters them with the authorized user's identity and
// active organization-admin memberships.

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installations/linkable',
    tags: ['github'],
    summary: 'POST /github/installations/linkable',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'Linkable GitHub App installations'),
      ...errors(400, 403, 502),
    },
  }),
  async (c: any) => {
    const body = await readBody(c);
    const scope = await resolveWorkspaceAccount(c, body);
    await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

    const githubUserToken = normalizeString(body.github_user_token ?? body.githubUserToken);
    if (!githubUserToken) {
      return c.json({ error: 'GitHub authorization is required to list installations' }, 400);
    }

    let linkable;
    try {
      linkable = await listLinkableGitHubAppInstallations(githubUserToken);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'Failed to list GitHub App installations',
        },
        502,
      );
    }

    const linkedRows = await listAccountGitHubInstallations(scope.accountId);
    const linkedIds = new Set(linkedRows.map((row) => row.installationId));
    const installUrl = await createGitHubInstallationInstallUrl(scope.accountId, scope.userId);

    return c.json({
      account_id: scope.accountId,
      github_login: linkable.githubLogin,
      configured: Boolean(installUrl),
      install_url: installUrl,
      installations: linkable.installations.map((installation) => ({
        installation_id: String(installation.id),
        owner_login: installation.account?.login ?? null,
        owner_type: installation.account?.type ?? installation.target_type ?? null,
        repository_selection: installation.repository_selection ?? null,
        permissions: installation.permissions ?? {},
        installation_url: installation.html_url ?? null,
        linked: linkedIds.has(String(installation.id)),
      })),
    });
  },
);

// POST /v1/workspaces/github/installations/link
// This same-origin path links an existing App installation without a GitHub
// install callback. The API verifies the installation against the App JWT and
// verifies the authorized GitHub user again before it writes the account row.

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installations/link',
    tags: ['github'],
    summary: 'POST /github/installations/link',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'Linked GitHub App installation'),
      ...errors(400, 403, 502),
    },
  }),
  async (c: any) => {
    const body = await readBody(c);
    const scope = await resolveWorkspaceAccount(c, body);
    await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

    const installationId = normalizeString(body.installation_id ?? body.installationId);
    if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
    if (!/^[0-9]+$/.test(installationId)) {
      return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
    }
    const githubUserToken = normalizeString(body.github_user_token ?? body.githubUserToken);
    if (!githubUserToken) {
      return c.json({ error: 'GitHub authorization is required to link this installation' }, 400);
    }

    let installation: GitHubAppInstallation;
    try {
      installation = await getGitHubAppInstallation(installationId);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'Failed to verify GitHub App installation',
        },
        502,
      );
    }

    try {
      await verifyGitHubInstallationAdmin(githubUserToken, installation);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'GitHub administrator verification failed',
        },
        403,
      );
    }

    try {
      const row = await upsertAccountGitHubInstallation(
        scope.accountId,
        installationId,
        installation,
      );
      return c.json(serializeGitHubInstallation(row, scope.accountId, null), 200);
    } catch (error) {
      return c.json(
        {
          error: (error as Error).message || 'Failed to save the GitHub installation',
        },
        502,
      );
    }
  },
);

// POST /v1/workspaces/github/installation
// Called after GitHub redirects back with installation_id + signed state.
// We fetch installation metadata with the app JWT instead of trusting client
// supplied owner information.

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/github/installation',
    tags: ['github'],
    summary: 'POST /github/installation',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 502),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const state = normalizeString(body.state);
  if (!state) return c.json({ error: 'state is required' }, 400);
  const statePayload = verifyGitHubAppInstallStatePayload(state);
  if (!statePayload?.accountId || !statePayload.nonce) {
    return c.json({ error: 'invalid GitHub installation state' }, 400);
  }

  const scope = await resolveWorkspaceAccount(c, { account_id: statePayload.accountId });
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const installationId = normalizeString(body.installation_id ?? body.installationId);
  if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
  if (!/^[0-9]+$/.test(installationId)) {
    return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
  }
  const githubUserToken = normalizeString(body.github_user_token ?? body.githubUserToken);
  if (!githubUserToken) {
    return c.json({ error: 'GitHub authorization is required to link this installation' }, 400);
  }

  let installation;
  try {
    installation = await getGitHubAppInstallation(installationId);
  } catch (error) {
    const message = (error as Error).message || 'Failed to verify GitHub App installation';
    return c.json({ error: message }, 502);
  }

  try {
    await verifyGitHubInstallationAdmin(githubUserToken, installation);
  } catch (error) {
    const message = (error as Error).message || 'GitHub administrator verification failed';
    return c.json({ error: message }, 403);
  }

  const stateStatus = await consumeGitHubInstallationState({
    accountId: scope.accountId,
    userId: scope.userId,
    nonce: statePayload.nonce,
    installationId,
  });
  if (stateStatus === 'invalid') {
    const existing = await getAccountGitHubInstallation(scope.accountId, installationId);
    if (existing?.installationId === installationId) {
      return c.json(serializeGitHubInstallation(existing, scope.accountId, null), 200);
    }
    return c.json({ error: 'GitHub installation state is expired or already used' }, 400);
  }

  try {
    const row = await upsertAccountGitHubInstallation(
      scope.accountId,
      installationId,
      installation,
    );
    return c.json(serializeGitHubInstallation(row, scope.accountId, null), 200);
  } catch (error) {
    return c.json(
      {
        error: (error as Error).message || 'Failed to save the GitHub installation',
      },
      502,
    );
  }
},
);

// DELETE /v1/workspaces/github/installation?account_id=...

workspacesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/github/installation',
    tags: ['github'],
    summary: 'DELETE /github/installation',
    ...auth,
      request: {
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveWorkspaceAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = normalizeString(c.req.query('installation_id') ?? c.req.query('installationId'));

  await db
    .delete(accountGithubInstallations)
    .where(installationId
      ? and(
          eq(accountGithubInstallations.accountId, scope.accountId),
          eq(accountGithubInstallations.installationId, installationId),
        )
      : eq(accountGithubInstallations.accountId, scope.accountId));

  return c.json({ ok: true });
},
);

// DELETE /v1/workspaces/github/installations/:installationId?account_id=...

workspacesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/github/installations/{installationId}',
    tags: ['github'],
    summary: 'DELETE /github/installations/:installationId',
    ...auth,
      request: {
        params: z.object({ installationId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
    },
  }),
  async (c: any) => {
  const scope = await resolveWorkspaceAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = c.req.param('installationId');

  await db
    .delete(accountGithubInstallations)
    .where(and(
      eq(accountGithubInstallations.accountId, scope.accountId),
      eq(accountGithubInstallations.installationId, installationId),
    ));

  return c.json({ ok: true });
},
);

// POST /v1/workspaces/link-repository
// Import an existing GitHub repo through the account GitHub App installation.
// This validates repo access up front and stores a typed workspace_git_connection.
