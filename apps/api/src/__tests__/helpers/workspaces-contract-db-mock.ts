import {
  accountGithubInstallations,
  accountMembers,
  workspaceGitConnections,
  workspaceMembers,
  workspaces,
} from '@kortix/db';

import {
  collectConditionValues,
  extractStringArray,
  queryResult,
} from './drizzle-query-mock';

export type AccountRole = 'owner' | 'admin' | 'member';
export type WorkspaceRole = 'manager' | 'editor' | 'member';

export interface WorkspaceRow {
  workspaceId: string;
  accountId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  lastOpenedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountMemberRow {
  userId: string;
  accountId: string;
  accountRole: AccountRole;
  joinedAt: Date;
}

export interface WorkspaceMemberRow {
  accountId: string;
  workspaceId: string;
  userId: string;
  workspaceRole: WorkspaceRole;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspacesContractDbState {
  accountMemberRows: AccountMemberRow[];
  workspaceRows: WorkspaceRow[];
  workspaceMemberRows: WorkspaceMemberRow[];
  installationRow: typeof accountGithubInstallations.$inferSelect | null;
  gitConnectionRows: Array<typeof workspaceGitConnections.$inferSelect>;
  nextWorkspaceIds: string[];
}

export const baseDate = new Date('2026-01-01T00:00:00Z');

export function workspaceRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    workspaceId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
    name: 'Existing Workspace',
    repoUrl: 'https://github.com/kortix/existing-workspace.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {},
    lastOpenedAt: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    ...overrides,
  };
}

function selectRows(
  state: WorkspacesContractDbState,
  table: unknown,
  fields: Record<string, unknown> | undefined,
  condition: unknown,
): any[] {
  const values = collectConditionValues(condition);
  const accountId = values.account_id as string | undefined;
  const userId = values.user_id as string | undefined;
  // The canonical Drizzle field is `workspaceId`. The expand-only migration
  // keeps the physical column name `project_id` during rolling deployment.
  const workspaceId = (values.workspace_id ?? values.project_id) as
    | string
    | undefined;
  const repoUrl = values.repo_url as string | undefined;
  const status = values.status as string | undefined;

  if (table === accountMembers) {
    return state.accountMemberRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!userId || row.userId === userId),
    );
  }
  if (table === workspaceMembers) {
    return state.workspaceMemberRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!workspaceId || row.workspaceId === workspaceId) &&
        (!userId || row.userId === userId),
    );
  }
  if (table === accountGithubInstallations)
    return state.installationRow ? [state.installationRow] : [];
  if (table === workspaceGitConnections) {
    return state.gitConnectionRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!workspaceId || row.workspaceId === workspaceId),
    );
  }
  if (table === workspaces) {
    const inArrayWorkspaceIds = extractStringArray(condition);
    return state.workspaceRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!workspaceId || row.workspaceId === workspaceId) &&
        (!repoUrl || row.repoUrl === repoUrl) &&
        (!status || row.status === status) &&
        (!inArrayWorkspaceIds || inArrayWorkspaceIds.includes(row.workspaceId)),
    );
  }
  return [];
}

function insertWorkspace(state: WorkspacesContractDbState, values: any) {
  const workspaceId = state.nextWorkspaceIds.shift();
  if (!workspaceId) throw new Error('test workspace id pool exhausted');
  const row: WorkspaceRow = {
    workspaceId,
    accountId: values.accountId,
    name: values.name,
    repoUrl: values.repoUrl,
    defaultBranch: values.defaultBranch ?? 'main',
    manifestPath: values.manifestPath ?? 'kortix.yaml',
    status: values.status ?? 'active',
    metadata: values.metadata ?? {},
    lastOpenedAt: null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  state.workspaceRows.push(row);
  return row;
}

function grantWorkspaceRole(
  state: WorkspacesContractDbState,
  values: any,
  set?: Partial<WorkspaceMemberRow>,
) {
  const existing = state.workspaceMemberRows.find(
    (row) => row.workspaceId === values.workspaceId && row.userId === values.userId,
  );
  if (existing) {
    Object.assign(existing, set ?? values);
    return existing;
  }
  const row: WorkspaceMemberRow = {
    accountId: values.accountId,
    workspaceId: values.workspaceId,
    userId: values.userId,
    workspaceRole: values.workspaceRole,
    grantedBy: values.grantedBy ?? null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  state.workspaceMemberRows.push(row);
  return row;
}

export function createWorkspacesContractDbMock(
  state: WorkspacesContractDbState,
): any {
  const dbMock: any = {
    execute: async () => [],
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) =>
          queryResult(selectRows(state, table, fields, condition)),
        orderBy: async () => selectRows(state, table, fields, undefined),
        innerJoin: () => ({
          where: (condition: unknown) =>
            queryResult(selectRows(state, table, fields, condition)),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoNothing: () => ({
          returning: async () => [],
        }),
        onConflictDoUpdate: ({ set }: { set?: Record<string, unknown> }) => ({
          returning: async () => {
            if (table === workspaces) {
              throw new Error(
                'workspace imports must insert instead of updating by repository',
              );
            }
            if (table === workspaceGitConnections) {
              const existingIndex = state.gitConnectionRows.findIndex(
                (row) => row.workspaceId === values.workspaceId,
              );
              const existing = state.gitConnectionRows[existingIndex];
              const row = {
                connectionId:
                  existing?.connectionId ??
                  '00000000-0000-4000-a000-000000000501',
                accountId: values.accountId,
                workspaceId: values.workspaceId,
                provider: values.provider,
                repoUrl: values.repoUrl,
                repoOwner: values.repoOwner ?? null,
                repoName: values.repoName ?? null,
                externalRepoId: values.externalRepoId ?? null,
                defaultBranch: values.defaultBranch,
                authMethod: values.authMethod,
                installationId: values.installationId ?? null,
                credentialRef: values.credentialRef ?? null,
                permissions: values.permissions ?? {},
                visibility: values.visibility ?? null,
                webhookId: values.webhookId ?? null,
                status: values.status ?? 'connected',
                lastValidatedAt: values.lastValidatedAt ?? baseDate,
                lastErrorCode: values.lastErrorCode ?? null,
                lastErrorMessage: values.lastErrorMessage ?? null,
                metadata: values.metadata ?? {},
                createdAt: existing?.createdAt ?? baseDate,
                updatedAt: values.updatedAt ?? baseDate,
              } as typeof workspaceGitConnections.$inferSelect;
              if (existingIndex >= 0)
                state.gitConnectionRows[existingIndex] = row;
              else state.gitConnectionRows.push(row);
              return [row];
            }
            return table === workspaceMembers
              ? [
                  grantWorkspaceRole(
                    state,
                    values,
                    set as Partial<WorkspaceMemberRow>,
                  ),
                ]
              : [];
          },
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(
              table === workspaceMembers
                ? [
                    grantWorkspaceRole(
                      state,
                      values,
                      set as Partial<WorkspaceMemberRow>,
                    ),
                  ]
                : [],
            ).then(resolve, reject),
          catch: () => undefined,
        }),
        returning: async () => {
          if (table === workspaces) return [insertWorkspace(state, values)];
          if (table === workspaceGitConnections) {
            return dbMock
              .insert(table)
              .values(values)
              .onConflictDoUpdate({})
              .returning();
          }
          return table === workspaceMembers
            ? [grantWorkspaceRole(state, values)]
            : [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<WorkspaceRow>) => ({
        where: (condition: unknown) => {
          const update = async () => {
            const values = collectConditionValues(condition);
            if (table !== workspaces) return [];
            const workspaceId = values.workspace_id ?? values.project_id;
            const row = state.workspaceRows.find(
              (workspace) => workspace.workspaceId === workspaceId,
            );
            if (!row) return [];
            const normalizedUpdates = { ...updates };
            if (
              normalizedUpdates.metadata &&
              typeof normalizedUpdates.metadata === 'object' &&
              'queryChunks' in normalizedUpdates.metadata
            ) {
              delete normalizedUpdates.metadata;
            }
            Object.assign(row, normalizedUpdates);
            return [row];
          };
          return {
            returning: update,
            then: (
              resolve: (value: unknown[]) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => update().then(resolve, reject),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        const values = collectConditionValues(condition);
        if (table === workspaceMembers) {
          const workspaceId = values.workspace_id ?? values.project_id;
          state.workspaceMemberRows = state.workspaceMemberRows.filter(
            (row) =>
              !(
                (!workspaceId || row.workspaceId === workspaceId) &&
                (!values.user_id || row.userId === values.user_id)
              ),
          );
        }
      },
    }),
  };
  dbMock.transaction = async (run: (tx: typeof dbMock) => Promise<unknown>) =>
    run(dbMock);
  return dbMock;
}
