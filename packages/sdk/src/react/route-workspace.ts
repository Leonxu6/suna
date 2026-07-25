'use client';

import { type ReactNode, createContext, createElement, useContext } from 'react';

/**
 * The route-scoped workspace id, injected by the host instead of read from a
 * router. The SDK is router-agnostic: a Next host derives the id from
 * `useParams()` and mounts `KortixWorkspaceProvider` once near its root; native
 * or CLI-driven hosts pass whatever their navigation state says. Hooks that
 * need "the workspace the user is looking at" (`useOpenCodeProviders`,
 * `useOpenCodeLocal`) read it via `useKortixRouteWorkspaceId`, which yields
 * `null` outside a workspace scope — the same as a non-workspace route.
 */
const KortixWorkspaceContext = createContext<string | null>(null);

export function KortixWorkspaceProvider(props: {
  workspaceId: string | null;
  children?: ReactNode;
}): ReactNode {
  return createElement(KortixWorkspaceContext.Provider, { value: props.workspaceId }, props.children);
}

export function useKortixRouteWorkspaceId(): string | null {
  return useContext(KortixWorkspaceContext);
}

/** @deprecated Use `KortixWorkspaceProvider`. */
export function KortixProjectProvider(props: {
  projectId: string | null;
  children?: ReactNode;
}): ReactNode {
  return createElement(KortixWorkspaceProvider, {
    workspaceId: props.projectId,
    children: props.children,
  });
}

/** @deprecated Use `useKortixRouteWorkspaceId`. */
export const useKortixRouteProjectId = useKortixRouteWorkspaceId;
