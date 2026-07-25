import { parseSharingIntent } from '../../executor/share';
import { WORKSPACE_ACTIONS } from '../../iam';
import { agentMayUseEnv, getAgentGrant } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { createAccountToken, listAccountTokens, revokeAccountToken } from '../../repositories/account-tokens';
import { db } from '../../shared/db';
import { kickRoutedPreBuild, templateBuildProviders } from '../../snapshots/builder';
import { getTemplateById } from '../../snapshots/templates';
import { roleAllows } from '../access';
import { loadWorkspaceConfig } from '../git';
import { parseBasicAuthHeader } from '../git-backends';
import { pollCodexDeviceAuth, startCodexDeviceAuth } from '../codex-device-auth';
import { decryptWorkspaceSecret, encryptWorkspaceSecret, identifierKeyConflicts, isValidIdentifier, isValidSecretName } from '../secrets';
import { propagateWorkspaceSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { seedWorkspaceDefaultModelOnConnect } from '../../llm-gateway/models/seed-default';
import { createRoute, z } from '@hono/zod-openapi';
import { workspaceSecrets, workspaceSessions, workspaces, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { loadWorkspaceForUser, assertWorkspaceCapability } from '../lib/access';
import { AnyObject, SecretSchema, workspacesApp } from '../lib/app';
import { getWorkspaceGitConnection, getWorkspaceGitRemote, hasServerManagedGitAuth, loadGitWorkspace, resolveWorkspaceGitAuth, resolveWorkspaceUpstream, upsertWorkspaceGitConnection, upsertWorkspaceGitCredential, withWorkspaceGitAuth } from '../lib/git';
import { CODEX_AUTH_JSON_SECRET_NAME, isSystemWorkspaceSecretName, loadSecretViewsForUser, normalizeString, readBody, serializeWorkspaceGitConnection } from '../lib/serializers';

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sandbox-templates/{templateId}/build',
    tags: ['sandboxes'],
    summary: 'POST /:workspaceId/sandbox-templates/:templateId/build',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), templateId: z.string() }),
      },
    responses: {
        202: json(z.any(), 'OK'),
        ...errors(404, 503),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const templateId = c.req.param('templateId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: building a sandbox template provisions infra. Gated on
  // workspace.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Editors hold it by default.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.workspaceId !== null && row.workspaceId !== workspaceId) {
    return c.json({ error: 'Not found' }, 404);
  }

  const workspace = await loadGitWorkspace(loaded);
  const providers = templateBuildProviders();
  if (providers.length === 0) {
    return c.json({ error: 'No sandbox template provider is enabled' }, 503);
  }
  kickRoutedPreBuild(workspace, {
    slug: row.slug,
    accountId: loaded.row.accountId,
    source: 'manual',
  });
  return c.json({
    status: 'started',
    template_id: row.templateId,
    slug: row.slug,
    providers,
  }, 202);
},
);

// ─── Workspace-scoped CLI tokens ─────────────────────────────────────────────
// These are PATs (`kortix_pat_...`) bound to a single workspace. The auth
// middleware enforces that the URL's `:workspaceId` matches the token's
// workspace_id, so the token is useless outside this one workspace. They're
// auto-minted at session-create time and injected into the sandbox as
// `KORTIX_TOKEN` so the in-container CLI works with zero config.


workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/cli-token',
    tags: ['workspaces'],
    summary: 'GET /:workspaceId/cli-token',
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
  const tokens = await listAccountTokens(loaded.row.accountId, workspaceId);
  return c.json({
    items: tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  });
},
);


workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/cli-token',
    tags: ['workspaces'],
    summary: 'POST /:workspaceId/cli-token',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadWorkspaceForUser(... 'manage') above,
  // which routes through the IAM engine (workspace.write).

  // Privilege-escalation guard: an agent-session token is itself a workspace
  // account token carrying a (possibly narrow) AgentGrant. If it could mint a
  // fresh workspace token, the new token would carry NO grant — letting a scoped
  // agent issue an unscoped sibling and escape its own ceiling. Token minting
  // is a human/manage operation; agents are denied outright.
  if (getAgentGrant(c)) {
    return c.json({ error: 'Agent-session tokens cannot mint workspace tokens' }, 403);
  }

  // One body field: `name`. Defaults to "cli · <workspace name>".
  let body: { name?: unknown } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    /* empty body is fine */
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 255)
      : `cli · ${loaded.row.name}`;

  const userId = c.get('userId') as string;
  const created = await createAccountToken({
    accountId: loaded.row.accountId,
    userId,
    workspaceId,
    name,
  });

  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      public_key: created.publicKey,
      secret_key: created.secretKey,
      status: created.status,
      workspace_id: created.workspaceId,
      expires_at: created.expiresAt?.toISOString() ?? null,
      created_at: created.createdAt.toISOString(),
    },
    201,
  );
},
);


workspacesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/cli-token/{tokenId}',
    tags: ['workspaces'],
    summary: 'DELETE /:workspaceId/cli-token/:tokenId',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), tokenId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const tokenId = c.req.param('tokenId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadWorkspaceForUser(... 'manage') above.
  // Token management is a human/manage operation: an agent-session token must
  // not revoke workspace tokens (it could knock out its own siblings / the human
  // CLI token as a DoS). Symmetric with the mint guard above.
  if (getAgentGrant(c)) {
    return c.json({ error: 'Agent-session tokens cannot manage workspace tokens' }, 403);
  }
  const ok = await revokeAccountToken(tokenId, loaded.row.accountId, workspaceId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);
  return c.json({ ok: true });
},
);

// GET /v1/workspaces/:workspaceId/git/clone-credential
// Runtime-only clone credential fetch. A session sandbox calls this endpoint
// with its sandbox-scoped KORTIX_TOKEN and gets a fresh provider credential
// just-in-time. Browser sessions must not receive raw Git tokens.

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/git/clone-credential',
    tags: ['github'],
    summary: 'GET /:workspaceId/git/clone-credential',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(403, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const authType = (c as any).get('authType') as string | undefined;
  const tokenWorkspaceId = (c as any).get('tokenWorkspaceId') as string | undefined;

  let workspaceRow: typeof workspaces.$inferSelect | null = null;

  if (authType === 'pat') {
    if (tokenWorkspaceId !== workspaceId) {
      return c.json({ error: 'clone credentials require a workspace-scoped runtime token' }, 403);
    }
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    workspaceRow = loaded.row;
  } else if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'clone credentials require a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.workspaceId, workspaceId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this workspace' }, 403);
    }
    const [row] = await db
      .select()
      .from(workspaces)
      .where(and(
        eq(workspaces.workspaceId, workspaceId),
        eq(workspaces.accountId, accountId),
      ))
      .limit(1);
    if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
    workspaceRow = row;
  } else {
    return c.json({ error: 'clone credentials are only available to runtime tokens' }, 403);
  }
  if (!workspaceRow) return c.json({ error: 'Not found' }, 404);

  const gitAuth = await resolveWorkspaceGitAuth(workspaceRow);
  const upstream = await resolveWorkspaceUpstream(workspaceRow, 'write');
  const credential = parseBasicAuthHeader(upstream?.headers.Authorization);
  if (!credential) {
    return c.json({
      repo_url: upstream?.url ?? workspaceRow.repoUrl,
      auth: null,
      source: gitAuth.authSource,
    });
  }

  return c.json({
    repo_url: upstream?.url ?? workspaceRow.repoUrl,
    auth: {
      username: credential.username,
      token: credential.token,
      type: 'basic',
    },
    source: gitAuth.authSource,
    expires_at: null,
  });
},
);

// PUT /v1/workspaces/:workspaceId/git-credential
// Stores provider-neutral BYO git credentials as platform credentials, not as
// user-readable/injectable runtime secrets. The managed GitHub backend mints
// credentials server-side; this exists for generic future providers such as
// GitLab/Bitbucket until they have first-class adapters.

workspacesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{workspaceId}/git-credential',
    tags: ['github'],
    summary: 'PUT /:workspaceId/git-credential',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Storing a git credential is a connector-write capability — a custom role can
  // omit workspace.connector.write to take credential management away from a
  // department, and an agent grant must include it (central fold) to write one.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE);

  if (await hasServerManagedGitAuth(loaded.row)) {
    return c.json({ error: 'Git auth is already managed by Kortix for this workspace' }, 409);
  }

  const token =
    typeof body.token === 'string'
      ? body.token.trim()
      : typeof body.value === 'string'
        ? body.value.trim()
        : '';
  if (!token) return c.json({ error: 'token is required' }, 400);

  const existingConnection = await getWorkspaceGitConnection(workspaceId);
  const remote = getWorkspaceGitRemote(loaded.row, existingConnection);
  const provider = normalizeString(body.provider) ?? (remote.provider === 'github' ? 'generic' : remote.provider);
  if (provider === 'github') {
    return c.json({ error: 'GitHub credentials are managed through the GitHub App connection' }, 409);
  }

  const credential = await upsertWorkspaceGitCredential({
    accountId: loaded.row.accountId,
    workspaceId,
    provider,
    token,
    createdBy: loaded.userId,
  });
  const connection = await upsertWorkspaceGitConnection({
    accountId: loaded.row.accountId,
    workspaceId,
    provider,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    authMethod: 'workspace_credential',
    credentialRef: credential.credentialId,
    status: 'connected',
    metadata: { credential_kind: 'token' },
  });

  return c.json({
    configured: true,
    provider,
    git_connection: serializeWorkspaceGitConnection(connection),
  }, 200);
},
);

// GET /v1/workspaces/:workspaceId/secrets
// Readable by any workspace member: returns each secret IDENTIFIER as the
// per-user view (the shared row + that member's own override, no plaintext)
// plus the manifest-declared required/optional env KEYS. Every workspace member
// with read access sees every secret — there is no per-secret member/group
// sharing. Members manage only their own override; managers additionally
// manage the shared row (`can_manage_shared`).

workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/secrets',
    tags: ['secrets'],
    summary: 'GET /:workspaceId/secrets',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
    responses: {
        200: json(z.array(SecretSchema), 'Secrets'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Leaf-gate the read (a custom role can omit workspace.secret.read) — and, via
  // the central agent-grant fold, an agent token must hold it in its kortixCli.
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ);

  const canManageShared = roleAllows(loaded.effectiveRole, 'manage');

  // Manifest is optional — a workspace without kortix.yaml just gets empty
  // required/optional lists. We surface loaded/missing/error explicitly so the
  // UI can distinguish "no envs declared" from "we couldn't read the manifest".
  let required: string[] = [];
  let optional: string[] = [];
  let manifestStatus: 'loaded' | 'missing' | 'error' = 'missing';
  let manifestError: string | null = null;
  try {
    const workspaceConfig = await loadWorkspaceConfig(await withWorkspaceGitAuth(loaded.row), []);
    required = workspaceConfig?.env?.required ?? [];
    optional = workspaceConfig?.env?.optional ?? [];
    manifestStatus = workspaceConfig?.manifest_raw ? 'loaded' : 'missing';
  } catch (err) {
    manifestStatus = 'error';
    manifestError = err instanceof Error ? err.message : String(err);
    console.warn('[workspaces] secrets: manifest load failed', {
      workspaceId,
      manifestPath: loaded.row.manifestPath,
      error: manifestError,
    });
  }

  // Per-agent secrets scoping: a scoped agent token only sees the IDENTIFIERS
  // it's granted (mirrors the env-injection narrowing), so it can't enumerate
  // secrets outside its allowlist. No-op for non-agent tokens / 'all' / null
  // grants. This is the ONLY gate — every workspace member with read access sees
  // every secret; there is no per-secret member/group sharing.
  const agentGrant = getAgentGrant(c);

  // KaaB per-session narrowing: a session-bound token (the executor PAT carries
  // sessionId) must not ENUMERATE identifiers its session allowlist hides —
  // otherwise the narrowing that scrubs those secrets from $ENV still leaks
  // their names/metadata here. Mirror the env-injection intersection.
  const boundSessionId = c.get('sessionId') as string | undefined;
  let sessionAllowUpper: Set<string> | null = null;
  if (boundSessionId) {
    const [sessionRow] = await db
      .select({ secretsAllowlist: workspaceSessions.secretsAllowlist })
      .from(workspaceSessions)
      .where(
        and(
          eq(workspaceSessions.sessionId, boundSessionId),
          eq(workspaceSessions.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    // Any non-null allowlist narrows the enumeration — including the empty array
    // (`[]` = enumerate ZERO secrets). Guard on `!= null`, not truthiness alone,
    // to make that intent explicit (an empty Set filters everything out below).
    if (sessionRow?.secretsAllowlist != null) {
      sessionAllowUpper = new Set(sessionRow.secretsAllowlist.map((id) => id.toUpperCase()));
    }
  }

  const items = (await loadSecretViewsForUser(workspaceId, loaded.userId, canManageShared))
    .filter((item) => !item.system)
    .filter((item) => agentMayUseEnv(agentGrant, item.identifier))
    .filter((item) => !sessionAllowUpper || sessionAllowUpper.has(item.identifier.toUpperCase()));

  return c.json({
    items,
    required,
    optional,
    // Page-level: may this member edit shared rows (add/set/share), or only
    // manage their own overrides?
    can_manage: canManageShared,
    manifest_status: manifestStatus,
    manifest_path: loaded.row.manifestPath,
    ...(manifestError ? { manifest_error: manifestError } : {}),
  });
},
);

// POST /v1/workspaces/:workspaceId/secrets
// Upsert a workspace secret. The response intentionally omits value/value_enc.

workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/secrets',
    tags: ['secrets'],
    summary: 'POST /:workspaceId/secrets',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(SecretSchema, 'The created secret'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE);

  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!isValidSecretName(name)) {
    return c.json({ error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' }, 400);
  }
  if (name.startsWith('KORTIX_')) {
    return c.json({ error: 'KORTIX_* names are reserved for platform/runtime-managed variables' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }

  // Identifier — the unique-per-workspace handle agents grant + the UI shows.
  // Defaults to the KEY when omitted (the simple/migrated case).
  const identifier = normalizeString(body.identifier) ?? name;
  if (!isValidIdentifier(identifier)) {
    return c.json({ error: 'identifier must be alphanumeric (A-Z, 0-9, _, ., -; max 128 chars)' }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;

  // Look up the existing SHARED row by IDENTIFIER so a key-unchanged edit
  // doesn't force re-entering the value. Creating a brand-new secret still
  // requires a value.
  const [existing] = await db
    .select({ secretId: workspaceSecrets.secretId, name: workspaceSecrets.name })
    .from(workspaceSecrets)
    .where(and(
      eq(workspaceSecrets.workspaceId, workspaceId),
      eq(workspaceSecrets.identifier, identifier),
      isNull(workspaceSecrets.ownerUserId),
    ))
    .limit(1);
  if (!existing && value === null) {
    return c.json({ error: 'value is required' }, 400);
  }
  // An identifier is a stable handle to ONE secret — redefining its underlying
  // KEY via upsert would silently retarget every agent grant that references
  // it. Reject instead of a surprising in-place key swap.
  if (identifierKeyConflicts(existing?.name ?? null, name)) {
    return c.json({
      error: `identifier "${identifier}" already exists with key "${existing!.name}" — delete it first to reuse the identifier with a different key`,
    }, 409);
  }

  const now = new Date();
  let secretId: string;
  if (value !== null) {
    const [row] = await db
      .insert(workspaceSecrets)
      .values({
        workspaceId,
        identifier,
        name,
        valueEnc: encryptWorkspaceSecret(workspaceId, value),
        createdBy: loaded.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // The shared row is unique on (workspace, identifier) WHERE owner_user_id IS NULL.
        target: [workspaceSecrets.workspaceId, workspaceSecrets.identifier],
        targetWhere: isNull(workspaceSecrets.ownerUserId),
        set: {
          valueEnc: encryptWorkspaceSecret(workspaceId, value),
          updatedAt: now,
        },
      })
      .returning({ secretId: workspaceSecrets.secretId });
    secretId = row.secretId;
  } else {
    // No value change (identifier/name unchanged) — nothing to do besides
    // touching updatedAt so the list reflects the write.
    await db
      .update(workspaceSecrets)
      .set({ updatedAt: now })
      .where(eq(workspaceSecrets.secretId, existing!.secretId));
    secretId = existing!.secretId;
  }

  void propagateWorkspaceSecretsToActiveSandboxes(workspaceId, { refreshModels: isGatewayManagedEnv(name) });

  // First provider connect on a default-less workspace → seed a sensible workspace
  // default model (that provider's flagship). Detached + idempotent; never seeds
  // over an existing default.
  if (value !== null && isGatewayManagedEnv(name)) {
    void seedWorkspaceDefaultModelOnConnect({
      workspaceId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      secretName: name,
    });
  }

  const views = await loadSecretViewsForUser(workspaceId, loaded.userId, true);
  const view = views.find((v) => v.identifier === identifier);
  return c.json(view ?? { identifier, name }, 200);
},
);

// ─── Provider OAuth device flow (poll-based) ───────────────────────────────
//
// Connect a subscription-backed LLM provider (today: a ChatGPT Plus/Pro
// account via the OpenAI Codex device grant) and save the resulting login as
// the workspace's CODEX_AUTH_JSON secret — which sandboxes materialize into
// OpenCode's auth.json on boot. No sandbox is required to connect.
//
// Two quick, NON-streaming calls so they survive any edge (a long-lived
// streaming response gets reset by Cloudflare) and any replica:
//   POST …/oauth/:provider/start → kicks the device flow in a DETACHED
//        background task on this replica, returns the device challenge.
//   POST …/oauth/:provider/poll  → ANY replica reads the shared DB flow row;
//        once the user finishes authorizing, writes the secret and returns it.
// The in-flight flow lives in `kortix.oauth_provider_flows` (not replica
// memory), so start and poll need not hit the same pod. The detached task
// isn't tied to a client connection, so nothing the edge does can kill it.

// Kortix provider id → the secret we persist the resulting auth.json under.
// Only OpenAI (ChatGPT) is wired today; the shape generalizes to others.
const OAUTH_PROVIDERS: Record<string, { secretName: string }> = {
  openai: { secretName: CODEX_AUTH_JSON_SECRET_NAME },
};

// How long the encrypted flow handle stays valid (OpenAI expires the device
// code on its side too; this just bounds the opaque handle clients hold).
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
// Floor for the client poll cadence (OpenAI returns its own suggested interval).
const OAUTH_POLL_INTERVAL_MS = 3000;

// Persists the Codex auth.json as the CODEX_AUTH_JSON workspace secret — private
// (the caller's own per-user OAuth login, ownerUserId-scoped) when `sharing`
// says so, else the workspace-wide shared row — then returns the caller's view
// of it. Codex-specific on purpose: a generic OPENCODE_AUTH_JSON row is never
// overwritten by this. `sharing` only ever chooses private-vs-shared here —
// member/group secret sharing was retired (see workspaces/secrets.ts).
async function writeCodexAuthSecret(input: {
  workspaceId: string;
  userId: string;
  value: string;
  sharing?: ReturnType<typeof parseSharingIntent>;
}) {
  const { workspaceId, userId, value, sharing } = input;
  const now = new Date();

  if (sharing?.mode === 'private') {
    await db
      .insert(workspaceSecrets)
      .values({
        workspaceId,
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptWorkspaceSecret(workspaceId, value),
        ownerUserId: userId,
        active: true,
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceSecrets.workspaceId, workspaceSecrets.name, workspaceSecrets.ownerUserId],
        targetWhere: sql`${workspaceSecrets.ownerUserId} is not null`,
        set: {
          valueEnc: encryptWorkspaceSecret(workspaceId, value),
          active: true,
          updatedAt: now,
        },
      });
  } else {
    await db
      .insert(workspaceSecrets)
      .values({
        workspaceId,
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptWorkspaceSecret(workspaceId, value),
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceSecrets.workspaceId, workspaceSecrets.identifier],
        targetWhere: isNull(workspaceSecrets.ownerUserId),
        set: {
          valueEnc: encryptWorkspaceSecret(workspaceId, value),
          updatedAt: now,
        },
      });
  }

  void propagateWorkspaceSecretsToActiveSandboxes(workspaceId, { refreshModels: true });

  const views = await loadSecretViewsForUser(workspaceId, userId, true);
  return views.find((v) => v.identifier === CODEX_AUTH_JSON_SECRET_NAME)
    ?? { identifier: CODEX_AUTH_JSON_SECRET_NAME, name: CODEX_AUTH_JSON_SECRET_NAME };
}

// Best-effort token expiry (ms remaining) from a stored auth.json, for display.
function authExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    // opencode auth.json is keyed by provider: { openai: { expires, ... } }.
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}

// ─── POST /v1/workspaces/:workspaceId/oauth/:provider/start ────────────────────
// Kick the device flow in a detached background task; return the challenge.
workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/oauth/{provider}/start',
    tags: ['secrets'],
    summary: 'POST /:workspaceId/oauth/:provider/start',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Device challenge'),
        ...errors(400, 401, 403, 404, 502),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const provider = c.req.param('provider');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (!OAUTH_PROVIDERS[provider]) {
    return c.json({ error: `OAuth device flow is not available for "${provider}"` }, 400);
  }

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be workspace|private|members' }, 400);
    }
  }
  // A shared credential is a workspace SECRET WRITE (the device flow persists it
  // via writeCodexAuthSecret on poll). Gate on the leaf so a custom role can
  // withhold it and the agent-grant fold applies — closing the gap where the
  // flow wrote a shared credential behind only loadWorkspaceForUser('read'). A
  // private (owner-only) credential is the member's own, so read still suffices.
  // The poll step is reachable only with the workspace-key-encrypted flow handle
  // minted here, so gating start transitively protects the write on poll.
  if (sharing?.mode !== 'private') {
    await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE);
  }

  // Request a device code straight from OpenAI — a couple HTTPS calls, no
  // subprocess, no server-side flow record. Everything `poll` needs is sealed
  // into the opaque `flow_id` (encrypted with the workspace key), so any replica
  // can serve any poll and there's nothing to leak or OOM.
  let challenge;
  try {
    challenge = await startCodexDeviceAuth();
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to start ChatGPT authorization',
    }, 502);
  }

  const expiresAt = Date.now() + DEVICE_AUTH_TTL_MS;
  const flowId = encryptWorkspaceSecret(
    workspaceId,
    JSON.stringify({
      d: challenge.deviceAuthId,
      u: challenge.userCode,
      s: sharing ?? null,
      uid: loaded.userId,
      e: expiresAt,
    }),
  );

  return c.json({
    flow_id: flowId,
    verification_url: challenge.verificationUrl,
    user_code: challenge.userCode,
    expires_at: expiresAt,
    interval_ms: Math.max(challenge.intervalMs, OAUTH_POLL_INTERVAL_MS),
  });
},
);

// ─── POST /v1/workspaces/:workspaceId/oauth/:provider/poll ─────────────────────
// Any replica: read the shared flow row; on success persist the secret.
workspacesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/oauth/{provider}/poll',
    tags: ['secrets'],
    summary: 'POST /:workspaceId/oauth/:provider/poll',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Poll result'),
        ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const provider = c.req.param('provider');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const flowId = normalizeString(body.flow_id);
  if (!flowId) return c.json({ error: 'flow_id is required' }, 400);

  // Decrypt the opaque flow handle. The key is workspace-scoped, so a handle from
  // another workspace — or a tampered one — simply won't decrypt → expired.
  let state: { d?: string; u?: string; s?: unknown; uid?: string; e?: number };
  try {
    state = JSON.parse(decryptWorkspaceSecret(workspaceId, flowId));
  } catch {
    return c.json({ status: 'expired' });
  }
  // Only the member who started it may poll it, and only before it expires.
  if (
    !state.d || !state.u ||
    state.uid !== loaded.userId ||
    typeof state.e !== 'number' || Date.now() > state.e
  ) {
    return c.json({ status: 'expired' });
  }

  const result = await pollCodexDeviceAuth({ deviceAuthId: state.d, userCode: state.u });
  if (result.status === 'pending') {
    return c.json({ status: 'pending', next_poll_ms: OAUTH_POLL_INTERVAL_MS });
  }
  if (result.status === 'failed') {
    return c.json({ status: 'failed', error: result.error });
  }

  // Authorized — persist the auth.json as the workspace secret with the sharing
  // chosen at start time (sealed, tamper-proof, in the flow handle).
  const sharing = state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined;
  await writeCodexAuthSecret({ workspaceId, userId: loaded.userId, value: result.authJson, sharing });

  return c.json({
    status: 'success',
    credential: {
      provider_id: provider,
      expires_in_ms: authExpiresInMs(result.authJson),
      updated_at: new Date().toISOString(),
    },
  });
},
);

// ─── GET /v1/workspaces/:workspaceId/oauth ─────────────────────────────────────
// List configured OAuth credentials (derived from the saved workspace secrets).
workspacesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/oauth',
    tags: ['secrets'],
    summary: 'GET /:workspaceId/oauth',
    ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
    responses: {
        200: json(z.any(), 'Configured OAuth credentials'),
        ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ);

  const items: Array<{ provider_id: string; expires_in_ms: number | null; updated_at: string }> = [];
  for (const [providerId, cfg] of Object.entries(OAUTH_PROVIDERS)) {
    const [row] = await db
      .select({ valueEnc: workspaceSecrets.valueEnc, updatedAt: workspaceSecrets.updatedAt })
      .from(workspaceSecrets)
      .where(and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.name, cfg.secretName),
        isNull(workspaceSecrets.ownerUserId),
      ))
      .limit(1);
    if (!row) continue;
    let expiresInMs: number | null = null;
    try {
      expiresInMs = authExpiresInMs(decryptWorkspaceSecret(workspaceId, row.valueEnc));
    } catch {
      // unreadable — leave unknown
    }
    items.push({
      provider_id: providerId,
      expires_in_ms: expiresInMs,
      updated_at: (row.updatedAt ?? new Date()).toISOString(),
    });
  }

  return c.json({ items });
},
);

// ─── DELETE /v1/workspaces/:workspaceId/oauth/:provider ────────────────────────
// Remove an OAuth credential (deletes the backing secret).
workspacesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/oauth/{provider}',
    tags: ['secrets'],
    summary: 'DELETE /:workspaceId/oauth/:provider',
    ...auth,
      request: { params: z.object({ workspaceId: z.string(), provider: z.string() }) },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const provider = c.req.param('provider');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE);

  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  await db
    .delete(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, cfg.secretName)));
  void propagateWorkspaceSecretsToActiveSandboxes(workspaceId, { refreshModels: isGatewayManagedEnv(cfg.secretName) });

  return c.json({ ok: true });
},
);

// DELETE /v1/workspaces/:workspaceId/secrets/:identifier
// `:identifier` addresses the secret's unique IDENTIFIER (defaults to its KEY
// for the simple/migrated case, so a plain key-name delete keeps working).

workspacesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/secrets/{name}',
    tags: ['secrets'],
    summary: 'DELETE /:workspaceId/secrets/:identifier',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), name: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const identifier = c.req.param('name')?.trim();
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertWorkspaceCapability(c, loaded.userId, loaded.row.accountId, workspaceId, WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE);
  if (!identifier || !isValidIdentifier(identifier)) {
    return c.json({ error: 'Invalid secret identifier' }, 400);
  }
  // A system row's identifier always equals its reserved KORTIX_* key (the
  // manifest never lets a human create one), so this alone protects it — no
  // DB read needed before the delete.
  if (isSystemWorkspaceSecretName(identifier)) {
    return c.json({ error: `${identifier} is managed by Kortix and cannot be removed` }, 403);
  }

  // Only the shared row — members' personal overrides for this identifier are
  // theirs to remove (via the /personal route) and are left intact.
  await db
    .delete(workspaceSecrets)
    .where(and(
      eq(workspaceSecrets.workspaceId, workspaceId),
      eq(workspaceSecrets.identifier, identifier),
      isNull(workspaceSecrets.ownerUserId),
    ));

  void propagateWorkspaceSecretsToActiveSandboxes(workspaceId, { refreshModels: isGatewayManagedEnv(identifier) });

  return c.json({ ok: true });
},
);

// PUT /v1/workspaces/:workspaceId/secrets/:name/personal
// Any workspace member sets/updates THEIR OWN per-key override (the "use mine"
// value) and/or flips whether it's active. Operates only on the caller's row;
// never touches the shared value or anyone else's override.

workspacesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{workspaceId}/secrets/{name}/personal',
    tags: ['secrets'],
    summary: 'PUT /:workspaceId/secrets/:name/personal',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), name: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await readBody(c);
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const name = c.req.param('name')?.trim().toUpperCase();
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (isSystemWorkspaceSecretName(name)) {
    return c.json({ error: 'KORTIX_* names are reserved and cannot be overridden' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }
  // LLM provider credentials are always workspace-wide. The gateway resolves
  // BYOK keys from the SHARED row only (getWorkspaceSecretValue), so a personal
  // override would show the provider as connected in the UI while every model
  // turn 400s with "No upstream configured" (2026-07-07 prod incident).
  if (isGatewayManagedEnv(name)) {
    return c.json(
      {
        error: `${name} is an LLM provider credential — provider keys are always workspace-wide, update the shared value instead`,
        code: 'llm_credentials_workspace_wide',
      },
      400,
    );
  }

  const value = typeof body.value === 'string' ? body.value : null;
  const active = typeof body.active === 'boolean' ? body.active : undefined;
  if (value === null && active === undefined) {
    return c.json({ error: 'value or active is required' }, 400);
  }

  const [existingMine] = await db
    .select({ secretId: workspaceSecrets.secretId })
    .from(workspaceSecrets)
    .where(and(
      eq(workspaceSecrets.workspaceId, workspaceId),
      eq(workspaceSecrets.name, name),
      eq(workspaceSecrets.ownerUserId, loaded.userId),
    ))
    .limit(1);

  const now = new Date();
  if (!existingMine) {
    if (value === null) {
      return c.json({ error: 'value is required to create an override' }, 400);
    }
    await db.insert(workspaceSecrets).values({
      workspaceId,
      identifier: name,
      name,
      valueEnc: encryptWorkspaceSecret(workspaceId, value),
      ownerUserId: loaded.userId,
      active: active ?? true,
      createdBy: loaded.userId,
      updatedAt: now,
    });
  } else {
    await db
      .update(workspaceSecrets)
      .set({
        ...(value !== null ? { valueEnc: encryptWorkspaceSecret(workspaceId, value) } : {}),
        ...(active !== undefined ? { active } : {}),
        updatedAt: now,
      })
      .where(eq(workspaceSecrets.secretId, existingMine.secretId));
  }

  void propagateWorkspaceSecretsToActiveSandboxes(workspaceId, { refreshModels: isGatewayManagedEnv(name) });

  const views = await loadSecretViewsForUser(workspaceId, loaded.userId, roleAllows(loaded.effectiveRole, 'manage'));
  return c.json(views.find((v) => v.name === name) ?? { name }, 200);
},
);

// DELETE /v1/workspaces/:workspaceId/secrets/:name/personal
// Remove the caller's own override for this key (falls back to the shared value).

workspacesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/secrets/{name}/personal',
    tags: ['secrets'],
    summary: 'DELETE /:workspaceId/secrets/:name/personal',
    ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), name: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }

  await db
    .delete(workspaceSecrets)
    .where(and(
      eq(workspaceSecrets.workspaceId, workspaceId),
      eq(workspaceSecrets.name, name),
      eq(workspaceSecrets.ownerUserId, loaded.userId),
    ));

  void propagateWorkspaceSecretsToActiveSandboxes(workspaceId, { refreshModels: isGatewayManagedEnv(name) });

  return c.json({ ok: true });
},
);

// GET /v1/workspaces/:workspaceId/triggers
//
// Lists triggers defined as files in `.opencode/triggers/*.md` on the
// workspace's default branch, plus any parse errors and runtime state
// (last_fired_at). The repo is the source of truth — POST/PATCH/DELETE
// below commit/update/delete the underlying file.
