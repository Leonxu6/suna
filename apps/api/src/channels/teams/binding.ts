import { chatChannelBindings, chatInstalls, workspaces } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ChannelCtx } from '../slack/selection';

const PLATFORM = 'teams';

export function teamsChannelCtx(tenantId: string, conversationId: string): ChannelCtx {
  return { teamId: tenantId, channelId: conversationId, platform: PLATFORM };
}

export async function listTenantWorkspaces(
  tenantId: string,
): Promise<Array<{ workspaceId: string; name: string }>> {
  const installs = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(
      and(eq(chatInstalls.platform, PLATFORM), eq(chatInstalls.providerWorkspaceId, tenantId)),
    );
  if (installs.length === 0) return [];
  const ids = installs.map((i) => i.workspaceId);
  const rows = await db
    .select({ workspaceId: workspaces.workspaceId, name: workspaces.name })
    .from(workspaces);
  const byId = new Map(rows.map((r) => [r.workspaceId, r.name]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => ({ workspaceId: id, name: byId.get(id) ?? id }));
}

export async function resolveConversationWorkspace(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  const [binding] = await db
    .select({ workspaceId: chatChannelBindings.workspaceId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, PLATFORM),
        eq(chatChannelBindings.providerWorkspaceId, tenantId),
        eq(chatChannelBindings.channelId, conversationId),
      ),
    )
    .limit(1);
  if (binding?.workspaceId) {
    const [installed] = await db
      .select({ workspaceId: chatInstalls.workspaceId })
      .from(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, PLATFORM),
          eq(chatInstalls.providerWorkspaceId, tenantId),
          eq(chatInstalls.workspaceId, binding.workspaceId),
        ),
      )
      .limit(1);
    if (installed) return binding.workspaceId;
  }

  const [install] = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(
      and(eq(chatInstalls.platform, PLATFORM), eq(chatInstalls.providerWorkspaceId, tenantId)),
    )
    .limit(1);
  return install?.workspaceId ?? null;
}

export async function ensureTeamsConversationBinding(input: {
  tenantId: string;
  conversationId: string;
  workspaceId: string;
  channelName?: string | null;
  channelType?: string | null;
}): Promise<boolean> {
  const [installed] = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, PLATFORM),
        eq(chatInstalls.providerWorkspaceId, input.tenantId),
        eq(chatInstalls.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!installed) return false;

  await db
    .insert(chatChannelBindings)
    .values({
      platform: PLATFORM,
      providerWorkspaceId: input.tenantId,
      channelId: input.conversationId,
      workspaceId: input.workspaceId,
      channelName: input.channelName ?? null,
      channelType: input.channelType ?? null,
    })
    .onConflictDoUpdate({
      target: [
        chatChannelBindings.platform,
        chatChannelBindings.providerWorkspaceId,
        chatChannelBindings.channelId,
      ],
      set: { workspaceId: input.workspaceId },
    });
  return true;
}

export async function setConversationWorkspace(input: {
  tenantId: string;
  conversationId: string;
  workspaceId: string;
}): Promise<boolean> {
  return ensureTeamsConversationBinding(input);
}
