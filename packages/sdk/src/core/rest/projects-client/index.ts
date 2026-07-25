/**
 * @deprecated Use `../workspaces-client` or the root Workspace exports.
 *
 * This compatibility barrel contains aliases only. The canonical
 * implementation lives in `workspaces-client` and calls `/workspaces`.
 */
export * from '../workspaces-client';

import {
  updateWorkspaceSandboxProvider,
  type KortixWorkspace,
  type PreparationView,
} from '../workspaces-client';
import type { SandboxProviderName } from '../platform-client/types';

/** @deprecated Use `KortixWorkspace`. */
export type KortixProject = Omit<KortixWorkspace, 'workspace_id'> & {
  project_id: string;
  workspace_id?: string;
};

/** @deprecated Use `UpdateWorkspaceSandboxProviderResult`. */
export type UpdateProjectSandboxProviderResult =
  | ({ kind: 'project' } & KortixProject)
  | PreparationView;

export type { CreateWorkspaceRepoInput as CreateProjectRepoInput } from "../workspaces-client";
export type { CreateWorkspaceSessionInput as CreateProjectSessionInput } from "../workspaces-client";
export type { CreateWorkspaceTriggerInput as CreateProjectTriggerInput } from "../workspaces-client";
export type { CreatedWorkspaceCliToken as CreatedProjectCliToken } from "../workspaces-client";
export type { FireWorkspaceTriggerResponse as FireProjectTriggerResponse } from "../workspaces-client";
export type { GatewayWorkspaceRoutingPolicy as GatewayProjectRoutingPolicy } from "../workspaces-client";
export type { GroupWorkspaceGrant as GroupProjectGrant } from "../workspaces-client";
export type { InviteWorkspaceMemberResult as InviteProjectMemberResult } from "../workspaces-client";
export type { MemberWorkspaceAccess as MemberProjectAccess } from "../workspaces-client";
export type { PendingWorkspaceInvite as PendingProjectInvite } from "../workspaces-client";
export type { ProvisionWorkspaceInput as ProvisionProjectInput } from "../workspaces-client";
export type { ProvisionWorkspaceWithTokenResult as ProvisionProjectWithTokenResult } from "../workspaces-client";
export type { RequestWorkspaceAccessResult as RequestProjectAccessResult } from "../workspaces-client";
export type { RequestWorkspaceConnectorInput as RequestProjectConnectorInput } from "../workspaces-client";
export type { RequestWorkspaceSecretInput as RequestProjectSecretInput } from "../workspaces-client";
export type { ResendWorkspaceInviteResult as ResendProjectInviteResult } from "../workspaces-client";
export type { UpdateWorkspaceDefaultAgentResponse as UpdateProjectDefaultAgentResponse } from "../workspaces-client";
export type { UpdateWorkspaceTriggerInput as UpdateProjectTriggerInput } from "../workspaces-client";
export type { WorkspaceAccessMember as ProjectAccessMember } from "../workspaces-client";
export type { WorkspaceAccessRequest as ProjectAccessRequest } from "../workspaces-client";
export type { WorkspaceAccessResponse as ProjectAccessResponse } from "../workspaces-client";
export type { WorkspaceAgentResourceItem as ProjectAgentResourceItem } from "../workspaces-client";
export type { WorkspaceBranch as ProjectBranch } from "../workspaces-client";
export type { WorkspaceBranchesResponse as ProjectBranchesResponse } from "../workspaces-client";
export type { WorkspaceCliToken as ProjectCliToken } from "../workspaces-client";
export type { WorkspaceCliTokenListResponse as ProjectCliTokenListResponse } from "../workspaces-client";
export type { WorkspaceCommit as ProjectCommit } from "../workspaces-client";
export type { WorkspaceCommitDetail as ProjectCommitDetail } from "../workspaces-client";
export type { WorkspaceCommitDiffResponse as ProjectCommitDiffResponse } from "../workspaces-client";
export type { WorkspaceCommitFile as ProjectCommitFile } from "../workspaces-client";
export type { WorkspaceCommitsResponse as ProjectCommitsResponse } from "../workspaces-client";
export type { WorkspaceConfigSummary as ProjectConfigSummary } from "../workspaces-client";
export type { WorkspaceDetail as ProjectDetail } from "../workspaces-client";
export type { WorkspaceFileEntry as ProjectFileEntry } from "../workspaces-client";
export type { WorkspaceFileHistoryResponse as ProjectFileHistoryResponse } from "../workspaces-client";
export type { WorkspaceFileSearchMatch as ProjectFileSearchMatch } from "../workspaces-client";
export type { WorkspaceFileSearchResponse as ProjectFileSearchResponse } from "../workspaces-client";
export type { WorkspaceGitConnection as ProjectGitConnection } from "../workspaces-client";
export type { WorkspaceGitToken as ProjectGitToken } from "../workspaces-client";
export type { WorkspaceGroupAccessSource as ProjectGroupAccessSource } from "../workspaces-client";
export type { WorkspaceGroupGrant as ProjectGroupGrant } from "../workspaces-client";
export type { WorkspaceInput as ProjectInput } from "../workspaces-client";
export type { WorkspaceLlmCatalogProvider as ProjectLlmCatalogProvider } from "../workspaces-client";
export type { WorkspaceLlmCatalogProvidersResponse as ProjectLlmCatalogProvidersResponse } from "../workspaces-client";
export type { WorkspaceLlmCatalogResponse as ProjectLlmCatalogResponse } from "../workspaces-client";
export type { WorkspaceOpenCodeSession as ProjectOpenCodeSession } from "../workspaces-client";
export type { WorkspacePoliciesResponse as ProjectPoliciesResponse } from "../workspaces-client";
export type { WorkspacePolicy as ProjectPolicy } from "../workspaces-client";
export type { WorkspaceResourceGrant as ProjectResourceGrant } from "../workspaces-client";
export type { WorkspaceResourceGrantsResponse as ProjectResourceGrantsResponse } from "../workspaces-client";
export type { WorkspaceResourceItem as ProjectResourceItem } from "../workspaces-client";
export type { WorkspaceRole as ProjectRole } from "../workspaces-client";
export type { WorkspaceSandboxHealth as ProjectSandboxHealth } from "../workspaces-client";
export type { WorkspaceSecret as ProjectSecret } from "../workspaces-client";
export type { WorkspaceSecretsResponse as ProjectSecretsResponse } from "../workspaces-client";
export type { WorkspaceSession as ProjectSession } from "../workspaces-client";
export type { WorkspaceSessionSandbox as ProjectSessionSandbox } from "../workspaces-client";
export type { WorkspaceSessionSandboxStatus as ProjectSessionSandboxStatus } from "../workspaces-client";
export type { WorkspaceSessionStatus as ProjectSessionStatus } from "../workspaces-client";
export type { WorkspaceSnapshotBuild as ProjectSnapshotBuild } from "../workspaces-client";
export type { WorkspaceSnapshotStatus as ProjectSnapshotStatus } from "../workspaces-client";
export type { WorkspaceSnapshotsResponse as ProjectSnapshotsResponse } from "../workspaces-client";
export type { WorkspaceTrigger as ProjectTrigger } from "../workspaces-client";
export type { WorkspaceTriggerListing as ProjectTriggerListing } from "../workspaces-client";
export type { WorkspaceTriggerParseError as ProjectTriggerParseError } from "../workspaces-client";
export type { WorkspaceTriggerSessionMode as ProjectTriggerSessionMode } from "../workspaces-client";
export type { WorkspaceTriggerType as ProjectTriggerType } from "../workspaces-client";
export { approveWorkspaceAccessRequest as approveProjectAccessRequest } from "../workspaces-client";
export { archiveWorkspace as archiveProject } from "../workspaces-client";
export { attachGroupToWorkspace as attachGroupToProject } from "../workspaces-client";
export { createWorkspace as createProject } from "../workspaces-client";
export { createWorkspaceCliToken as createProjectCliToken } from "../workspaces-client";
export { createWorkspaceRepo as createProjectRepo } from "../workspaces-client";
export { createWorkspaceResourceGrant as createProjectResourceGrant } from "../workspaces-client";
export { createWorkspaceSession as createProjectSession } from "../workspaces-client";
export { createWorkspaceTrigger as createProjectTrigger } from "../workspaces-client";
export { deletePersonalWorkspaceSecret as deletePersonalProjectSecret } from "../workspaces-client";
export { deleteWorkspaceResourceGrant as deleteProjectResourceGrant } from "../workspaces-client";
export { deleteWorkspaceSecret as deleteProjectSecret } from "../workspaces-client";
export { deleteWorkspaceSession as deleteProjectSession } from "../workspaces-client";
export { deleteWorkspaceTrigger as deleteProjectTrigger } from "../workspaces-client";
export { detachGroupFromWorkspace as detachGroupFromProject } from "../workspaces-client";
export { ensureWorkspaceConnectorProfile as ensureProjectConnectorProfile } from "../workspaces-client";
export { fetchWorkspaceArchive as fetchProjectArchive } from "../workspaces-client";
export { fetchWorkspacesForAccountWithToken as fetchProjectsForAccountWithToken } from "../workspaces-client";
export { fireWorkspaceTrigger as fireProjectTrigger } from "../workspaces-client";
export { getWorkspace as getProject } from "../workspaces-client";
export { getWorkspaceCommit as getProjectCommit } from "../workspaces-client";
export { getWorkspaceCommitDiff as getProjectCommitDiff } from "../workspaces-client";
export { getWorkspaceDetail as getProjectDetail } from "../workspaces-client";
export { getWorkspaceFileHistory as getProjectFileHistory } from "../workspaces-client";
export { getWorkspaceGitToken as getProjectGitToken } from "../workspaces-client";
export { getWorkspaceLlmCatalog as getProjectLlmCatalog } from "../workspaces-client";
export { getWorkspaceLlmCatalogProviders as getProjectLlmCatalogProviders } from "../workspaces-client";
export { getWorkspaceModelPicker as getProjectModelPicker } from "../workspaces-client";
export { getWorkspaceSandboxHealth as getProjectSandboxHealth } from "../workspaces-client";
export { getWorkspaceSandboxProviderTransition as getProjectSandboxProviderTransition } from "../workspaces-client";
export { getWorkspaceSession as getProjectSession } from "../workspaces-client";
export { inviteWorkspaceMember as inviteProjectMember } from "../workspaces-client";
export { isManagedGithubWorkspace as isManagedGithubProject } from "../workspaces-client";
export { listGroupWorkspaceGrants as listGroupProjectGrants } from "../workspaces-client";
export { listMemberWorkspaceAccess as listMemberProjectAccess } from "../workspaces-client";
export { listPendingWorkspaceInvites as listPendingProjectInvites } from "../workspaces-client";
export { listWorkspaceAccess as listProjectAccess } from "../workspaces-client";
export { listWorkspaceAccessRequests as listProjectAccessRequests } from "../workspaces-client";
export { listWorkspaceBranches as listProjectBranches } from "../workspaces-client";
export { listWorkspaceCliTokens as listProjectCliTokens } from "../workspaces-client";
export { listWorkspaceCommits as listProjectCommits } from "../workspaces-client";
export { listWorkspaceFiles as listProjectFiles } from "../workspaces-client";
export { listWorkspaceGroupGrants as listProjectGroupGrants } from "../workspaces-client";
export { listWorkspacePolicies as listProjectPolicies } from "../workspaces-client";
export { listWorkspaceResourceGrants as listProjectResourceGrants } from "../workspaces-client";
export { listWorkspaceSandboxTemplates as listProjectSandboxTemplates } from "../workspaces-client";
export { listWorkspaceSandboxes as listProjectSandboxes } from "../workspaces-client";
export { listWorkspaceSecrets as listProjectSecrets } from "../workspaces-client";
export { listWorkspaceSessions as listProjectSessions } from "../workspaces-client";
export { listWorkspaceSnapshots as listProjectSnapshots } from "../workspaces-client";
export { listWorkspaceTriggers as listProjectTriggers } from "../workspaces-client";
export { listWorkspaces as listProjects } from "../workspaces-client";
export { listWorkspacesForAccount as listProjectsForAccount } from "../workspaces-client";
export { pollWorkspaceProviderOAuth as pollProjectProviderOAuth } from "../workspaces-client";
export { provisionWorkspace as provisionProject } from "../workspaces-client";
export { provisionWorkspaceWithToken as provisionProjectWithToken } from "../workspaces-client";
export { readWorkspaceFile as readProjectFile } from "../workspaces-client";
export { rebuildWorkspaceSnapshot as rebuildProjectSnapshot } from "../workspaces-client";
export { rejectWorkspaceAccessRequest as rejectProjectAccessRequest } from "../workspaces-client";
export { requestWorkspaceAccess as requestProjectAccess } from "../workspaces-client";
export { requestWorkspaceConnector as requestProjectConnector } from "../workspaces-client";
export { requestWorkspaceSecret as requestProjectSecret } from "../workspaces-client";
export { resendPendingWorkspaceInvite as resendPendingProjectInvite } from "../workspaces-client";
export { restartWorkspaceSession as restartProjectSession } from "../workspaces-client";
export { revokePendingWorkspaceInvite as revokePendingProjectInvite } from "../workspaces-client";
export { revokeWorkspaceAccess as revokeProjectAccess } from "../workspaces-client";
export { revokeWorkspaceCliToken as revokeProjectCliToken } from "../workspaces-client";
export { searchWorkspaceFiles as searchProjectFiles } from "../workspaces-client";
export { setPersonalWorkspaceSecret as setPersonalProjectSecret } from "../workspaces-client";
export { setWorkspaceOnboardingComplete as setProjectOnboardingComplete } from "../workspaces-client";
export { setWorkspacePolicies as setProjectPolicies } from "../workspaces-client";
export { setWorkspaceSessionSharing as setProjectSessionSharing } from "../workspaces-client";
export { setWorkspaceTriggersActivation as setProjectTriggersActivation } from "../workspaces-client";
export { startWorkspaceProviderOAuth as startProjectProviderOAuth } from "../workspaces-client";
export { startWorkspaceSession as startProjectSession } from "../workspaces-client";
export { stopWorkspaceSession as stopProjectSession } from "../workspaces-client";
export { updateWorkspace as updateProject } from "../workspaces-client";
export { updateWorkspaceAccess as updateProjectAccess } from "../workspaces-client";
export { updateWorkspaceDefaultAgent as updateProjectDefaultAgent } from "../workspaces-client";
export { updateWorkspaceGroupGrant as updateProjectGroupGrant } from "../workspaces-client";
/** @deprecated Use `updateWorkspaceSandboxProvider`. */
export async function updateProjectSandboxProvider(
  projectId: string,
  provider: SandboxProviderName | null,
): Promise<UpdateProjectSandboxProviderResult> {
  const result = await updateWorkspaceSandboxProvider(projectId, provider);
  if (result.kind === 'workspace') {
    const { workspace_id, ...workspace } = result;
    return {
      ...workspace,
      kind: 'project',
      project_id: workspace_id,
      workspace_id,
    };
  }
  return {
    ...result,
    project_id: result.project_id ?? result.workspace_id,
  } as PreparationView;
}
export { updateWorkspaceSession as updateProjectSession } from "../workspaces-client";
export { updateWorkspaceTrigger as updateProjectTrigger } from "../workspaces-client";
export { upsertWorkspaceGitCredential as upsertProjectGitCredential } from "../workspaces-client";
export { upsertWorkspaceSecret as upsertProjectSecret } from "../workspaces-client";
export { validateWorkspaceManifest as validateProjectManifest } from "../workspaces-client";
export { workspaceSessionStartSeed as projectSessionStartSeed } from "../workspaces-client";
