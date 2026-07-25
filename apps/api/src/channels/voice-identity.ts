/**
 * The bot's display name in a meeting — the one piece of meet-voices.ts that
 * survives the voice rebuild. The ElevenLabs voice catalog and the wake word
 * both died with the notetaker architecture: the realtime provider supplies its
 * own voices, and server-side VAD replaced wake-word gating entirely.
 *
 * Storage stays on the `meet` metadata subtree so existing workspaces keep the
 * name their owners set; only the code around it was renamed.
 */
import { eq } from 'drizzle-orm';
import { workspaces } from '@kortix/db';
import { metadataMergeSubtree } from '../workspaces/lib/metadata-merge';
import { db } from '../shared/db';

const METADATA_SUBTREE = 'meet';

export const DEFAULT_VOICE_BOT_NAME = 'Kortix';

export async function resolveWorkspaceBotName(workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ metadata: workspaces.metadata })
    .from(workspaces)
    .where(eq(workspaces.workspaceId, workspaceId))
    .limit(1);
  const name = (row?.metadata as Record<string, any> | null)?.[METADATA_SUBTREE]?.bot_name;
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_VOICE_BOT_NAME;
}

export async function setWorkspaceBotName(workspaceId: string, name: string): Promise<string> {
  const clean = name.trim().slice(0, 80) || DEFAULT_VOICE_BOT_NAME;
  // `meet` is a NESTED object — merge the current sub-object in-SQL so concurrent
  // writes don't lose each other's fields and no top-level key is reverted.
  await db
    .update(workspaces)
    .set({ metadata: metadataMergeSubtree(METADATA_SUBTREE, { bot_name: clean }), updatedAt: new Date() })
    .where(eq(workspaces.workspaceId, workspaceId));
  return clean;
}
