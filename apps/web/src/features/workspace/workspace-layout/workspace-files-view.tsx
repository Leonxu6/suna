'use client';

/**
 * Standalone workspace Files view — the Google-Drive-style browser over the
 * workspace repo. Rendered by the /workspaces/[id]/files page inside the regular
 * WorkspaceShell (NOT the Customize overlay — Files is a top-level surface any
 * member can open, so it lives outside customization entirely).
 */

import { Skeleton } from '@/components/ui/skeleton';
import {
  FileExplorerPage,
  FileExplorerSourceProvider,
  FilesStoreProvider,
  gitRefExplorerSource,
  WorkspaceFilesProvider,
  useSelectedVersion,
} from '@/features/workspace-files';
import { getWorkspace } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

export function WorkspaceFilesView({ workspaceId }: { workspaceId: string }) {
  const workspaceQuery = useQuery({
    queryKey: ['workspaces', workspaceId, 'meta'],
    queryFn: () => getWorkspace(workspaceId),
    staleTime: 60_000,
  });

  const selectedVersion = useSelectedVersion(workspaceId);

  if (workspaceQuery.isLoading || !workspaceQuery.data) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-border/40 h-12 border-b" />
        <div className="space-y-2 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  const defaultBranch = workspaceQuery.data.default_branch;
  const activeRef = selectedVersion ?? defaultBranch;

  return (
    <WorkspaceFilesProvider value={{ workspaceId, ref: activeRef, defaultBranch }}>
      <FileExplorerSourceProvider value={gitRefExplorerSource}>
        <FilesStoreProvider>
          <FileExplorerPage />
        </FilesStoreProvider>
      </FileExplorerSourceProvider>
    </WorkspaceFilesProvider>
  );
}
