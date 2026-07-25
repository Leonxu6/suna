/**
 * Deprecated Project compatibility boundary.
 *
 * Canonical callers import `workspace-link.ts`.
 */
import {
  clearLink,
  isKortixWorkspace,
  linkFilePath,
  loadLink as loadWorkspaceLink,
  resolveWorkspaceId,
  saveLink as saveWorkspaceLink,
} from './workspace-link.ts';

export { clearLink, linkFilePath };

/** @deprecated Use `WorkspaceLink`. */
export interface ProjectLink {
  project_id: string;
  workspace_id?: string;
  account_id: string;
  host?: string;
  host_url?: string;
  linked_at: string;
}

/** @deprecated Use `isKortixWorkspace`. */
export const isKortixProject = isKortixWorkspace;

/** @deprecated Use `loadLink` from `workspace-link.ts`. */
export function loadLink(cwd = process.cwd()): ProjectLink | null {
  const link = loadWorkspaceLink(cwd);
  if (!link) return null;
  return {
    project_id: link.workspace_id,
    workspace_id: link.workspace_id,
    account_id: link.account_id,
    host: link.host,
    host_url: link.host_url,
    linked_at: link.linked_at,
  };
}

/** @deprecated Use `saveLink` from `workspace-link.ts`. */
export function saveLink(link: ProjectLink, cwd = process.cwd()): void {
  saveWorkspaceLink(
    {
      workspace_id: link.workspace_id ?? link.project_id,
      account_id: link.account_id,
      host: link.host,
      host_url: link.host_url,
      linked_at: link.linked_at,
    },
    cwd,
  );
}

/** @deprecated Use `resolveWorkspaceId`. */
export const resolveProjectId = resolveWorkspaceId;
