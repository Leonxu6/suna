import {
  type accountGithubInstallations,
  workspaceGitConnections,
  workspaceGitCredentials,
  workspaceMembers,
  workspaces,
} from '@kortix/db';

import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { db } from '../../shared/db';
import type { GitHubRepo } from '../github';
import { encryptWorkspaceSecret } from '../secrets';
import { type WorkspaceRow, clampWorkspaceName, deriveWorkspaceName } from './serializers';

type GitHubInstallation = typeof accountGithubInstallations.$inferSelect;

type RegistrationAuth =
  | { kind: 'github_app'; installation: GitHubInstallation }
  | { kind: 'workspace_credential'; token: string };

type RegistrationInput = {
  accountId: string;
  userId: string;
  repo: GitHubRepo;
  name?: string | null;
  defaultBranch: string;
  manifestPath: string;
  /** True only when Kortix created the upstream repository for this workspace. */
  managed?: boolean;
  auth: RegistrationAuth;
};

async function registerLinkedWorkspace(input: RegistrationInput): Promise<WorkspaceRow> {
  const workspaceName = clampWorkspaceName(input.name ?? deriveWorkspaceName(input.repo.full_name));
  const owner = input.repo.full_name.split('/')[0] ?? null;
  const now = new Date();
  const githubApp = input.auth.kind === 'github_app' ? input.auth.installation : null;
  const authMethod = githubApp ? 'github_app' : 'workspace_credential';
  const metadata = {
    git: {
      url: input.repo.clone_url,
      default_branch: input.defaultBranch,
      provider: 'github',
      owner,
      name: input.repo.name,
      external_repo_id: String(input.repo.id),
      managed: input.managed ?? false,
      auth: githubApp
        ? { method: authMethod, installation_id: githubApp.installationId }
        : { method: authMethod },
    },
    github: {
      repo_id: String(input.repo.id),
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      private: input.repo.private,
      auth_source: githubApp ? 'app_installation' : 'pat',
      ...(githubApp ? { installation_id: githubApp.installationId } : {}),
    },
  };

  const row = await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        accountId: input.accountId,
        name: workspaceName,
        repoUrl: input.repo.clone_url,
        defaultBranch: input.defaultBranch,
        manifestPath: input.manifestPath,
        status: 'active',
        metadata,
        updatedAt: now,
      })
      .returning();
    if (!workspace) throw new Error('Workspace registration did not return the inserted workspace');

    let credentialRef: string | null = null;
    if (input.auth.kind === 'workspace_credential') {
      const valueEnc = encryptWorkspaceSecret(workspace.workspaceId, input.auth.token);
      const [credential] = await tx
        .insert(workspaceGitCredentials)
        .values({
          accountId: input.accountId,
          workspaceId: workspace.workspaceId,
          provider: 'github',
          authMethod: 'token',
          valueEnc,
          createdBy: input.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [workspaceGitCredentials.workspaceId, workspaceGitCredentials.provider],
          set: {
            valueEnc,
            createdBy: input.userId,
            updatedAt: now,
          },
        })
        .returning();
      if (!credential) throw new Error('Workspace Git credential was not persisted');
      credentialRef = credential.credentialId;
    }

    const connection = {
      provider: 'github',
      repoUrl: input.repo.clone_url,
      repoOwner: owner,
      repoName: input.repo.name,
      externalRepoId: String(input.repo.id),
      managed: input.managed ?? false,
      defaultBranch: input.defaultBranch,
      authMethod,
      installationId: githubApp?.installationId ?? null,
      credentialRef,
      permissions: githubApp?.permissions ?? {},
      visibility: input.repo.private ? 'private' : 'public',
      status: 'connected',
      lastValidatedAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: input.repo.full_name,
        html_url: input.repo.html_url,
        ssh_url: input.repo.ssh_url,
      },
      updatedAt: now,
    };
    await tx
      .insert(workspaceGitConnections)
      .values({
        accountId: input.accountId,
        workspaceId: workspace.workspaceId,
        ...connection,
      })
      .onConflictDoUpdate({
        target: workspaceGitConnections.workspaceId,
        set: connection,
      })
      .returning();

    await tx
      .insert(workspaceMembers)
      .values({
        accountId: input.accountId,
        workspaceId: workspace.workspaceId,
        userId: input.userId,
        workspaceRole: 'manager',
        grantedBy: input.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: {
          workspaceRole: 'manager',
          grantedBy: input.userId,
          updatedAt: now,
        },
      })
      .returning();

    return workspace;
  });

  invalidateIamCacheForUser(input.userId);
  return row;
}

export function registerGitHubLinkedWorkspace(
  input: Omit<RegistrationInput, 'auth'> & { installation: GitHubInstallation },
): Promise<WorkspaceRow> {
  const { installation, ...workspace } = input;
  return registerLinkedWorkspace({
    ...workspace,
    auth: { kind: 'github_app', installation },
  });
}

export function registerPatLinkedWorkspace(
  input: Omit<RegistrationInput, 'auth'> & { token: string },
): Promise<WorkspaceRow> {
  const { token, ...workspace } = input;
  return registerLinkedWorkspace({
    ...workspace,
    auth: { kind: 'workspace_credential', token },
  });
}
