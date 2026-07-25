/**
 * Deprecated `kortix projects` compatibility entry point.
 *
 * The implementation lives in `workspaces.ts`. This module must not contain a
 * second command implementation.
 */
import {
  configureClonedWorkspaceAuth,
  resolveWorkspaceCloneTarget,
  runWorkspaces,
  saveClonedWorkspaceLink,
  type WorkspaceCloneTarget,
} from './workspaces.ts';

import type { ProjectSummary } from '../api/types.ts';

export * from './workspaces.ts';

/** @deprecated Use `WorkspaceCloneTarget`. */
export type ProjectCloneTarget = WorkspaceCloneTarget;

/** @deprecated Use `configureClonedWorkspaceAuth`. */
export const configureClonedProjectAuth = configureClonedWorkspaceAuth;

/** @deprecated Use `resolveWorkspaceCloneTarget`. */
export function resolveProjectCloneTarget(project: ProjectSummary): WorkspaceCloneTarget;
export function resolveProjectCloneTarget(project: ProjectSummary, kortixToken: string): WorkspaceCloneTarget;
export function resolveProjectCloneTarget(
  project: ProjectSummary,
  kortixToken = '',
): WorkspaceCloneTarget {
  return resolveWorkspaceCloneTarget(
    {
      ...project,
      workspace_id: project.workspace_id ?? project.project_id,
    },
    kortixToken,
  );
}

/** @deprecated Use `saveClonedWorkspaceLink`. */
export function saveClonedProjectLink(
  repoRoot: string,
  project: ProjectSummary,
  host: string | undefined,
  hostUrl: string,
): void {
  saveClonedWorkspaceLink(
    repoRoot,
    {
      ...project,
      workspace_id: project.workspace_id ?? project.project_id,
    },
    host,
    hostUrl,
  );
}

/** @deprecated Use `runWorkspaces`. */
export async function runProjects(argv: string[]): Promise<number> {
  process.stderr.write('kortix: "projects" is deprecated. Use "workspaces".\n');
  return runWorkspaces(argv);
}
