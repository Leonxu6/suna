/**
 * The database keeps project-era enum values during the rolling compatibility
 * window. These adapters isolate that storage contract from the workspace API.
 */

export type WorkspaceSessionVisibility = 'private' | 'workspace' | 'restricted';
export type PersistedSessionVisibility = 'private' | 'project' | 'restricted';

export function toPersistedSessionVisibility(
  visibility: WorkspaceSessionVisibility,
): PersistedSessionVisibility {
  return visibility === 'workspace' ? 'project' : visibility;
}

export function fromPersistedSessionVisibility(
  visibility: PersistedSessionVisibility,
): WorkspaceSessionVisibility {
  return visibility === 'project' ? 'workspace' : visibility;
}

export type WorkspaceConnectorOwnerType =
  | 'member'
  | 'workspace'
  | 'agent'
  | 'subject'
  | 'external';
export type PersistedConnectorOwnerType =
  | 'member'
  | 'project'
  | 'agent'
  | 'subject'
  | 'external';

export function toPersistedConnectorOwnerType(
  ownerType: WorkspaceConnectorOwnerType,
): PersistedConnectorOwnerType {
  return ownerType === 'workspace' ? 'project' : ownerType;
}

export function fromPersistedConnectorOwnerType(
  ownerType: PersistedConnectorOwnerType,
): WorkspaceConnectorOwnerType {
  return ownerType === 'project' ? 'workspace' : ownerType;
}

export type WorkspaceBudgetScope = 'workspace' | 'member';
export type PersistedBudgetScope = 'project' | 'member';

export function toPersistedBudgetScope(scope: WorkspaceBudgetScope): PersistedBudgetScope {
  return scope === 'workspace' ? 'project' : scope;
}
