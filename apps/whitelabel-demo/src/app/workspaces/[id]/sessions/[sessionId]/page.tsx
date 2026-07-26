'use client';

import { WorkspaceShell } from '@/components/workspace-shell';
import { BootScreen } from '@/components/workbench/boot-screen';
import { SessionHeader } from '@/components/workbench/session-header';
import { WorkbenchTabs } from '@/components/workbench/workbench-tabs';
import { useSession } from '@kortix/sdk/react';
import { useParams } from 'next/navigation';

export default function SessionWorkbenchPage() {
  return (
    <WorkspaceShell>
      <Workbench />
    </WorkspaceShell>
  );
}

function Workbench() {
  const params = useParams();
  const workspaceId = String(params.id);
  const sessionId = String(params.sessionId);

  // One hook owns readiness, transport selection, streaming, transcript
  // projection, interactive requests, and message synchronization.
  // The host reads the provider-neutral session state and renders it.
  const session = useSession(workspaceId, sessionId);

  return (
    <>
      <SessionHeader workspaceId={workspaceId} sessionId={sessionId} />
      {session.phase !== 'ready' ? (
        <BootScreen
          stage={session.stage ?? undefined}
          reason={session.reason ?? undefined}
          failed={session.isError}
          onRetry={session.retry}
        />
      ) : (
        <WorkbenchTabs session={session} workspaceId={workspaceId} sessionId={sessionId} />
      )}
    </>
  );
}
