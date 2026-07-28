import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Account/agent/WORKSPACE-scoped default model preferences. A FIFO-ish chain mock
// captures select rows + insert values without a real DB.

let selectRows: any[] = [];
let insertedValues: any = null;
let deleteWhereArgs: any[] = [];
let conflictMode: 'update' | 'nothing' | null = null;
let conflictConfig: any = null;

function collectSqlIdentifiers(value: unknown, seen = new Set<unknown>()): string[] {
  if (value == null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  const identifiers = typeof record.name === 'string' ? [record.name] : [];
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) identifiers.push(...collectSqlIdentifiers(item, seen));
    } else {
      identifiers.push(...collectSqlIdentifiers(child, seen));
    }
  }
  return identifiers;
}

function chain(): any {
  const c: any = {};
  for (const m of ['select', 'from', 'update', 'set', 'returning', 'limit', 'leftJoin']) {
    c[m] = () => c;
  }
  c.where = (...args: any[]) => {
    deleteWhereArgs = args;
    return c;
  };
  c.values = (v: any) => {
    insertedValues = v;
    return c;
  };
  c.onConflictDoUpdate = (config: any) => {
    conflictMode = 'update';
    conflictConfig = config;
    return Promise.resolve();
  };
  c.onConflictDoNothing = (config: any) => {
    conflictMode = 'nothing';
    conflictConfig = config;
    return Promise.resolve();
  };
  c.then = (resolve: (rows: any[]) => unknown) => Promise.resolve(resolve(selectRows));
  return c;
}
mock.module('../shared/db', () => ({
  db: { select: () => chain(), insert: () => chain(), delete: () => chain() },
  hasDatabase: () => true,
}));

const {
  getAccountModelDefaults,
  getSessionAgentContext,
  upsertAccountModelPreference,
  deleteAccountModelPreference,
} = await import('./model-preferences');

beforeEach(() => {
  selectRows = [];
  insertedValues = null;
  deleteWhereArgs = [];
  conflictMode = null;
  conflictConfig = null;
});

describe('getAccountModelDefaults', () => {
  test('buckets account / agent / workspace rows (legacy workspace-less agent row, no workspaceId arg)', async () => {
    selectRows = [
      { scope: 'account', scopeKey: '', workspaceId: null, model: 'glm-5.2' },
      { scope: 'agent', scopeKey: 'reviewer', workspaceId: null, model: 'claude-opus-4.8' },
      { scope: 'workspace', scopeKey: 'p1', workspaceId: null, model: 'anthropic/claude-sonnet-4.6' },
      { scope: 'workspace', scopeKey: 'p2', workspaceId: null, model: 'qwen3.7-max' },
    ];
    const defaults = await getAccountModelDefaults('a1');
    expect(defaults.account).toBe('glm-5.2');
    expect(defaults.agents).toEqual({ reviewer: 'claude-opus-4.8' });
    expect(defaults.workspaces).toEqual({ p1: 'anthropic/claude-sonnet-4.6', p2: 'qwen3.7-max' });
  });

  test('empty → all buckets empty', async () => {
    expect(await getAccountModelDefaults('a1')).toEqual({ account: null, agents: {}, workspaces: {} });
  });

  // The core bug fix: agent-scope pins keyed only by agent name used to be
  // account-wide, so workspace A and workspace B (same account, both declaring an
  // agent named 'kortix' in their own kortix.yaml) silently shared ONE pin.
  describe('per-workspace agent pin isolation', () => {
    test('workspace A and workspace B hold INDEPENDENT pins for the same agent name', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-a', model: 'anthropic/claude-opus-4.8' },
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-b', model: 'anthropic/claude-sonnet-4.6' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      const defaultsB = await getAccountModelDefaults('a1', 'proj-b');
      expect(defaultsA.agents).toEqual({ kortix: 'anthropic/claude-opus-4.8' });
      expect(defaultsB.agents).toEqual({ kortix: 'anthropic/claude-sonnet-4.6' });
    });

    test('a pin for workspace A never leaks into workspace C (unrelated workspace, no pin of its own)', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-a', model: 'anthropic/claude-opus-4.8' },
      ];
      const defaultsC = await getAccountModelDefaults('a1', 'proj-c');
      expect(defaultsC.agents).toEqual({});
    });

    test('legacy workspace-less pin (workspace_id NULL) applies as a fallback to every workspace that has not re-pinned', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', workspaceId: null, model: 'legacy-shared-model' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      const defaultsB = await getAccountModelDefaults('a1', 'proj-b');
      expect(defaultsA.agents).toEqual({ kortix: 'legacy-shared-model' });
      expect(defaultsB.agents).toEqual({ kortix: 'legacy-shared-model' });
    });

    test('a workspace-scoped pin overrides the legacy fallback for THAT workspace only', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', workspaceId: null, model: 'legacy-shared-model' },
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-a', model: 'proj-a-override' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      const defaultsB = await getAccountModelDefaults('a1', 'proj-b');
      expect(defaultsA.agents).toEqual({ kortix: 'proj-a-override' });
      expect(defaultsB.agents).toEqual({ kortix: 'legacy-shared-model' });
    });

    test('omitting workspaceId returns ONLY the legacy fallback, never another workspace\'s pin', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', workspaceId: null, model: 'legacy-shared-model' },
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-a', model: 'proj-a-override' },
      ];
      const noWorkspaceContext = await getAccountModelDefaults('a1');
      expect(noWorkspaceContext.agents).toEqual({ kortix: 'legacy-shared-model' });
    });

    test('different agent names on different workspaces coexist independently', async () => {
      selectRows = [
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-a', model: 'opus' },
        { scope: 'agent', scopeKey: 'reviewer', workspaceId: 'proj-a', model: 'sonnet' },
        { scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-b', model: 'haiku' },
      ];
      const defaultsA = await getAccountModelDefaults('a1', 'proj-a');
      expect(defaultsA.agents).toEqual({ kortix: 'opus', reviewer: 'sonnet' });
    });
  });
});

describe('upsertAccountModelPreference', () => {
  test('workspace scope writes scope_key = workspaceId, workspace_id column stays null', async () => {
    await upsertAccountModelPreference({ accountId: 'a1', scope: 'workspace', scopeKey: 'p1', model: 'glm-5.2' });
    expect(insertedValues).toMatchObject({ accountId: 'a1', scope: 'workspace', scopeKey: 'p1', workspaceId: null, model: 'glm-5.2' });
    expect(conflictMode).toBe('update');
    // Targets the GLOBAL partial index (account_id, scope, scope_key) WHERE workspace_id IS NULL.
    expect(conflictConfig.target).toHaveLength(3);
    expect(conflictConfig.targetWhere).toBeDefined();
    expect(collectSqlIdentifiers(conflictConfig.targetWhere)).toContain('project_id');
  });

  test('account scope pins scope_key to empty string, workspace_id stays null', async () => {
    await upsertAccountModelPreference({ accountId: 'a1', scope: 'account', model: 'glm-5.2' });
    expect(insertedValues.scopeKey).toBe('');
    expect(insertedValues.workspaceId).toBeNull();
  });

  test('agent scope WITH a workspaceId writes workspace_id and targets the 4-column workspace partial index', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'agent',
      scopeKey: 'kortix',
      workspaceId: 'proj-a',
      model: 'anthropic/claude-opus-4.8',
    });
    expect(insertedValues).toMatchObject({
      accountId: 'a1',
      scope: 'agent',
      scopeKey: 'kortix',
      workspaceId: 'proj-a',
      model: 'anthropic/claude-opus-4.8',
    });
    expect(conflictConfig.target).toHaveLength(4);
  });

  test('agent scope WITHOUT a workspaceId falls back to the legacy global partial index (workspace_id null)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'agent',
      scopeKey: 'kortix',
      model: 'anthropic/claude-opus-4.8',
    });
    expect(insertedValues.workspaceId).toBeNull();
    expect(conflictConfig.target).toHaveLength(3);
  });

  test('workspaceId is ignored for non-agent scopes (never written)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'workspace',
      scopeKey: 'p1',
      workspaceId: 'proj-a',
      model: 'glm-5.2',
    });
    expect(insertedValues.workspaceId).toBeNull();
  });

  test('onlyIfAbsent uses INSERT … ON CONFLICT DO NOTHING (idempotent seed)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'workspace',
      scopeKey: 'p1',
      model: 'glm-5.2',
      onlyIfAbsent: true,
    });
    expect(conflictMode).toBe('nothing');
  });
});

describe('deleteAccountModelPreference', () => {
  test('agent scope with a workspaceId only targets that workspace\'s row', async () => {
    await deleteAccountModelPreference({ accountId: 'a1', scope: 'agent', scopeKey: 'kortix', workspaceId: 'proj-a' });
    expect(deleteWhereArgs.length).toBeGreaterThan(0);
  });

  test('agent scope without a workspaceId targets the legacy (workspace_id IS NULL) row only', async () => {
    await deleteAccountModelPreference({ accountId: 'a1', scope: 'agent', scopeKey: 'kortix' });
    expect(deleteWhereArgs.length).toBeGreaterThan(0);
  });
});

// The join that lets a caller resolve the 'default' agent-name sentinel to
// the owning workspace's declared default agent (see default-model.ts's
// cachedSessionAgent) — the fix for agent-scope model pins silently never
// applying to sessions whose agent_name never resolved past 'default'.
describe('getSessionAgentContext', () => {
  test('no row for sessionId → null', async () => {
    selectRows = [];
    expect(await getSessionAgentContext('s-missing')).toBeNull();
  });

  test('carries the joined workspace.metadata.default_agent as workspaceDefaultAgent', async () => {
    selectRows = [
      { agentName: 'default', metadata: {}, workspaceMetadata: { default_agent: 'kortix' } },
    ];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx).toEqual({ agentName: 'default', opencodeModel: null, workspaceDefaultAgent: 'kortix' });
  });

  test('workspace metadata with no default_agent → workspaceDefaultAgent null', async () => {
    selectRows = [{ agentName: 'default', metadata: {}, workspaceMetadata: { git: {} } }];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx?.workspaceDefaultAgent).toBeNull();
  });

  test('null workspace metadata (left join miss / never happens in practice, but must not throw) → workspaceDefaultAgent null', async () => {
    selectRows = [{ agentName: 'default', metadata: {}, workspaceMetadata: null }];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx?.workspaceDefaultAgent).toBeNull();
  });

  test('blank-string default_agent is treated as unset', async () => {
    selectRows = [{ agentName: 'default', metadata: {}, workspaceMetadata: { default_agent: '   ' } }];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx?.workspaceDefaultAgent).toBeNull();
  });

  test('still surfaces the session-level opencode_model override unchanged', async () => {
    selectRows = [
      {
        agentName: 'release-bot',
        metadata: { opencode_model: 'anthropic/claude-opus-4.8' },
        workspaceMetadata: { default_agent: 'kortix' },
      },
    ];
    const ctx = await getSessionAgentContext('s1');
    expect(ctx).toEqual({
      agentName: 'release-bot',
      opencodeModel: 'anthropic/claude-opus-4.8',
      workspaceDefaultAgent: 'kortix',
    });
  });
});
