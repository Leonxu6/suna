/** Deprecated Project compatibility boundary. */
import {
  ensureDefaultWorkspaceBinding,
  type BindOutcome,
} from './workspace-bind.ts';

export type { BindOutcome };

/** @deprecated Use `ensureDefaultWorkspaceBinding`. */
export const ensureDefaultProjectBinding = ensureDefaultWorkspaceBinding;
