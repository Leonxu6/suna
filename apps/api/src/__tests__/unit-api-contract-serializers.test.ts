import { describe, expect, test } from 'bun:test';
import {
  WorkspaceSchema,
  WorkspaceSessionSandboxSchema,
  WorkspaceSessionSchema,
  WorkspaceSecretSchema,
  SessionStartResultSchema,
} from '@kortix/api-contract';
import type { workspaceSecrets, workspaceSessions, workspaces, sessionSandboxes } from '@kortix/db';
import { config } from '../config';
import { buildSecretView, serializeWorkspace, serializeSession } from '../workspaces/lib/serializers';
import { serializeSandboxRow } from '../workspaces/routes/shared';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const WORKSPACE_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_ID = '99999999-8888-4777-8666-555555555555';
const USER_ID = '77777777-6666-4555-8444-333333333333';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function workspaceRow(
  overrides: Partial<typeof workspaces.$inferSelect> = {},
): typeof workspaces.$inferSelect {
  return {
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    name: 'Demo Workspace',
    sandboxProviderGeneration: 0,
    repoUrl: 'https://github.com/acme/demo',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {},
    lastOpenedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function sessionRow(
  overrides: Partial<typeof workspaceSessions.$inferSelect> = {},
): typeof workspaceSessions.$inferSelect {
  return {
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    branchName: 'kortix/session-1',
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: null,
    sandboxUrl: null,
    opencodeSessionId: 'ses_abc',
    agentName: 'default',
    status: 'running',
    error: null,
    createdBy: USER_ID,
    visibility: 'private',
    origin: 'user',
    originRef: null,
    secretsAllowlist: null,
    connectorBindingsInheritUnbound: false,
    metadata: { name: 'Fix the login bug' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function sandboxRow(
  overrides: Partial<typeof sessionSandboxes.$inferSelect> = {},
): typeof sessionSandboxes.$inferSelect {
  return {
    sandboxId: SESSION_ID,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    provider: 'platinum',
    externalId: 'sbx-123',
    baseUrl: 'https://sbx-123.proxy.kortix.com',
    status: 'active',
    config: { serviceKey: 'sensitive', region: 'eu' },
    metadata: {},
    lastUsedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function secretRow(
  overrides: Partial<typeof workspaceSecrets.$inferSelect> = {},
): typeof workspaceSecrets.$inferSelect {
  return {
    secretId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    workspaceId: WORKSPACE_ID,
    identifier: overrides.name ?? 'OPENAI_API_KEY',
    name: 'OPENAI_API_KEY',
    valueEnc: 'enc:v1:abc',
    scope: 'runtime',
    ownerUserId: null,
    active: true,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('serializeWorkspace ⇄ WorkspaceSchema', () => {
  test('output parses strictly and round-trips unchanged', () => {
    const out = serializeWorkspace(workspaceRow(), {
      workspaceRole: 'editor',
      effectiveRole: 'editor',
    });
    expect(WorkspaceSchema.strict().parse(out)).toEqual(out);
  });

  test('output without access context parses with null roles', () => {
    const out = serializeWorkspace(workspaceRow({ lastOpenedAt: null }));
    const parsed = WorkspaceSchema.strict().parse(out);
    expect(parsed.workspace_role).toBeNull();
    expect(parsed.effective_workspace_role).toBeNull();
    expect(parsed.last_opened_at).toBeNull();
  });

  test('experimental map carries every registered feature key', () => {
    const out = serializeWorkspace(workspaceRow());
    expect(Object.keys(out.experimental).sort()).toEqual(
      Object.keys(WorkspaceSchema.shape.experimental.shape).sort(),
    );
  });

  test('surfaces a configured E2B workspace pin', () => {
    const originalAllowed = config.ALLOWED_SANDBOX_PROVIDERS;
    const originalKey = config.E2B_API_KEY;
    config.ALLOWED_SANDBOX_PROVIDERS = ['e2b'];
    config.E2B_API_KEY = 'test-only';
    try {
      const out = serializeWorkspace(workspaceRow({ metadata: { default_sandbox_provider: 'e2b' } }));
      expect(out.default_sandbox_provider).toBe('e2b');
      expect(WorkspaceSchema.strict().parse(out)).toEqual(out);
    } finally {
      config.ALLOWED_SANDBOX_PROVIDERS = originalAllowed;
      config.E2B_API_KEY = originalKey;
    }
  });

  test.each(['managed', 'local_docker', 'justavps', 'unknown']) (
    'does not surface retired or unknown workspace pin %s',
    (provider) => {
      const out = serializeWorkspace(workspaceRow({ metadata: { default_sandbox_provider: provider } }));
      expect(out.default_sandbox_provider).toBeNull();
      expect(WorkspaceSchema.strict().parse(out)).toEqual(out);
    },
  );
});

describe('serializeSession ⇄ WorkspaceSessionSchema', () => {
  test('owner view parses strictly and round-trips unchanged', () => {
    const out = serializeSession(sessionRow(), {
      viewerId: USER_ID,
      canManageWorkspace: false,
    });
    expect(WorkspaceSessionSchema.strict().parse(out)).toEqual(out);
  });

  test('restricted shared view with grants parses', () => {
    const out = serializeSession(sessionRow({ visibility: 'restricted' }), {
      grants: [{ principalType: 'member', principalId: USER_ID }],
      viewerId: 'someone-else',
      canManageWorkspace: true,
      ownerEmail: 'owner@acme.dev',
      ownerName: 'Build Agent',
      ownerType: 'service_account',
      canAccess: false,
      runtimeStatus: 'stopped',
      deletedAt: '2026-07-20T10:00:00.000Z',
      deletedBy: USER_ID,
    });
    const parsed = WorkspaceSessionSchema.strict().parse(out);
    expect(parsed.sharing).toEqual({ mode: 'members', memberIds: [USER_ID], groupIds: [] });
    expect(parsed.owner_email).toBe('owner@acme.dev');
    expect(parsed.owner_name).toBe('Build Agent');
    expect(parsed.owner_type).toBe('service_account');
    expect(parsed.can_access).toBe(false);
    expect(parsed.runtime_status).toBe('stopped');
    expect(parsed.deleted_at).toBe('2026-07-20T10:00:00.000Z');
    expect(parsed.deleted_by).toBe(USER_ID);
    expect(parsed.is_owner).toBe(false);
  });

  test('custom_name override wins over the auto title', () => {
    const out = serializeSession(sessionRow({ metadata: { name: 'auto', custom_name: 'Mine' } }));
    const parsed = WorkspaceSessionSchema.strict().parse(out);
    expect(parsed.name).toBe('Mine');
    expect(parsed.custom_name).toBe('Mine');
  });
});

describe('serializeSandboxRow ⇄ WorkspaceSessionSandboxSchema', () => {
  test('output parses strictly and scrubs serviceKey from config', () => {
    const out = serializeSandboxRow(sandboxRow());
    const parsed = WorkspaceSessionSandboxSchema.strict().parse(out);
    expect(parsed).toEqual(out);
    expect(parsed.config).toEqual({ region: 'eu' });
  });

  test('start payload embedding the serialized row parses', () => {
    const payload = {
      stage: 'ready' as const,
      agent_name: 'default',
      retriable: false,
      sandbox: serializeSandboxRow(sandboxRow()),
      opencode_session_id: 'ses_abc',
      runtime_transport: 'acp' as const,
      runtime_url: '/p/sbx-123/8000',
      reason: 'pinned',
    };
    expect(SessionStartResultSchema.strict().parse(payload)).toEqual(payload);
  });
});

describe('buildSecretView ⇄ WorkspaceSecretSchema', () => {
  test('shared workspace secret parses strictly and round-trips unchanged', () => {
    const out = buildSecretView({
      identifier: 'OPENAI_API_KEY',
      name: 'OPENAI_API_KEY',
      shared: secretRow(),
      canManageShared: true,
    });
    expect(WorkspaceSecretSchema.strict().parse(out)).toEqual(out);
    expect(out.effective_source).toBe('shared');
  });

  test('two identifiers sharing the same key parse as independent secrets', () => {
    const primary = buildSecretView({
      identifier: 'GMAPS-primary',
      name: 'GOOGLE_MAPS_API_KEY',
      shared: secretRow({ identifier: 'GMAPS-primary', name: 'GOOGLE_MAPS_API_KEY' }),
      canManageShared: true,
    });
    const backup = buildSecretView({
      identifier: 'GMAPS-backup',
      name: 'GOOGLE_MAPS_API_KEY',
      shared: secretRow({ identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' }),
      canManageShared: true,
    });
    expect(WorkspaceSecretSchema.strict().parse(primary)).toEqual(primary);
    expect(WorkspaceSecretSchema.strict().parse(backup)).toEqual(backup);
    expect(primary.name).toBe(backup.name);
    expect(primary.identifier).not.toBe(backup.identifier);
  });

  test('personal override view parses', () => {
    const out = buildSecretView({
      identifier: 'OPENAI_API_KEY',
      name: 'OPENAI_API_KEY',
      personal: secretRow({ ownerUserId: USER_ID }),
      canManageShared: false,
    });
    const parsed = WorkspaceSecretSchema.strict().parse(out);
    expect(parsed.configured).toBe(false);
    expect(parsed.effective_source).toBe('mine');
    expect(parsed.mine).toEqual({ active: true, updated_at: NOW.toISOString() });
  });

  test('system git-auth secret parses and cannot be managed even by an editor', () => {
    const out = buildSecretView({
      identifier: 'KORTIX_GIT_AUTH_TOKEN',
      name: 'KORTIX_GIT_AUTH_TOKEN',
      shared: secretRow({ identifier: 'KORTIX_GIT_AUTH_TOKEN', name: 'KORTIX_GIT_AUTH_TOKEN' }),
      canManageShared: true,
    });
    const parsed = WorkspaceSecretSchema.strict().parse(out);
    expect(parsed.system).toBe(true);
    expect(parsed.purpose).toBe('git_auth');
    expect(parsed.can_manage_shared).toBe(false);
  });
});
