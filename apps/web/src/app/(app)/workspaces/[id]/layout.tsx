import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { LlmCatalogBootstrap } from '@/components/workspaces/llm-catalog-bootstrap';
import { WorkspaceAccessBoundary } from '@/components/workspaces/workspace-access-boundary';
import { SessionCacheWarmer } from '@/components/workspaces/session-cache-warmer';
import { WorkspaceShell } from '@/features/workspace/workspace-layout/workspace-shell';
import { createClient } from '@/lib/supabase/server';

interface WorkspaceLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export default async function WorkspaceLayout({ children, params }: WorkspaceLayoutProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/auth');

  void (await cookies());

  const { id: workspaceId } = await params;

  return (
    <WorkspaceAccessBoundary workspaceId={workspaceId}>
      <SessionCacheWarmer workspaceId={workspaceId} />
      <LlmCatalogBootstrap workspaceId={workspaceId} />
      <WorkspaceShell workspaceId={workspaceId}>{children}</WorkspaceShell>
    </WorkspaceAccessBoundary>
  );
}
