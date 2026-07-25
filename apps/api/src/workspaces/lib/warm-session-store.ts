import { workspaceSessions } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { WorkspaceSessionRow } from './serializers';

const availableWarmSession = sql`
  ${workspaceSessions.metadata}->'warm_session'->>'state' = 'available'
`;
const notDeleted = sql`
  coalesce(${workspaceSessions.metadata}->>'deletedAt', '') = ''
`;

export interface WarmWorkspaceSessionScope {
  accountId: string;
  workspaceId: string;
  userId: string;
}

export async function findAvailableWarmWorkspaceSession(
  scope: WarmWorkspaceSessionScope,
): Promise<WorkspaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(workspaceSessions)
    .where(
      and(
        eq(workspaceSessions.accountId, scope.accountId),
        eq(workspaceSessions.workspaceId, scope.workspaceId),
        eq(workspaceSessions.createdBy, scope.userId),
        availableWarmSession,
        notDeleted,
      ),
    )
    .orderBy(desc(workspaceSessions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function discardAvailableWarmWorkspaceSession(
  scope: WarmWorkspaceSessionScope,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(workspaceSessions)
    .set({ metadata, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceSessions.accountId, scope.accountId),
        eq(workspaceSessions.workspaceId, scope.workspaceId),
        eq(workspaceSessions.createdBy, scope.userId),
        eq(workspaceSessions.sessionId, sessionId),
        availableWarmSession,
      ),
    );
}

export async function claimAvailableWarmWorkspaceSession(
  scope: WarmWorkspaceSessionScope,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<WorkspaceSessionRow | null> {
  const [row] = await db
    .update(workspaceSessions)
    .set({ metadata, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceSessions.accountId, scope.accountId),
        eq(workspaceSessions.workspaceId, scope.workspaceId),
        eq(workspaceSessions.createdBy, scope.userId),
        eq(workspaceSessions.sessionId, sessionId),
        availableWarmSession,
        notDeleted,
      ),
    )
    .returning();
  return row ?? null;
}
