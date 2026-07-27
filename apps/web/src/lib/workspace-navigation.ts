type AccountWorkspacePreference = {
  default_workspace_id?: string | null;
};

type WorkspaceReference = {
  workspace_id: string;
};

export function selectAccountWorkspace<T extends WorkspaceReference>(
  account: AccountWorkspacePreference,
  workspaces: readonly T[],
): T | undefined {
  return (
    workspaces.find((workspace) => workspace.workspace_id === account.default_workspace_id) ??
    workspaces[0]
  );
}

export function accountWorkspaceDestination(
  account: AccountWorkspacePreference,
  workspaces: readonly WorkspaceReference[],
): string {
  const workspace = selectAccountWorkspace(account, workspaces);
  return workspace ? `/workspaces/${workspace.workspace_id}` : '/workspaces';
}

export function shouldRenderWorkspaceSwitcher(_workspaces: readonly WorkspaceReference[]): boolean {
  return true;
}

export function workspaceManagementPath(accountId: string, search = ''): string {
  return `/accounts/${accountId}/workspaces${search ? `?${search}` : ''}`;
}

export function legacyWorkspaceDestination(
  slug: readonly string[],
  values: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) params.append(key, item);
    }
  }
  const query = params.toString();
  const path = `/workspaces${slug.length > 0 ? `/${slug.join('/')}` : ''}`;
  return `${path}${query ? `?${query}` : ''}`;
}
