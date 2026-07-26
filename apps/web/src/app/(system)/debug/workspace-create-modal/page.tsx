'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WorkspaceCreateModal } from '@/features/workspaces/modal/workspace-create-modal';
import { setBootstrapAuthToken } from '@/lib/auth-token';

export default function DebugWorkspaceCreateModalPage() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setBootstrapAuthToken('debug-workspace-create-token');
    return () => setBootstrapAuthToken(null);
  }, []);

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <Button type="button" onClick={() => setOpen(true)}>
        Open workspace create modal
      </Button>
      <WorkspaceCreateModal
        open={open}
        onOpenChange={setOpen}
        accountId="00000000-0000-4000-a000-000000000101"
      />
    </main>
  );
}
