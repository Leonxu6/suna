/**
 * Connections this wrapper may bind to a new session.
 *
 * Provider-neutral and pre-filtered: a wrapper can only bind TEAM connections
 * (see `selectBindableConnections`), so the client is never shown an option that
 * would fail at session create.
 */
import { selectBindableConnections } from '@/server/bindable-connections';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidWorkspaceId } from '@/server/users';
import { createScopedKortix } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) return Response.json({ connections: [] });

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limited' }, { status: 429 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId') ?? '';
  const connector = url.searchParams.get('connector') ?? '';
  if (!isValidWorkspaceId(workspaceId) || !connector) {
    return Response.json({ error: 'Invalid identifiers' }, { status: 400 });
  }
  if (!isOwner(session.userId, workspaceId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const kortix = createScopedKortix({
    backendUrl: process.env.KORTIX_API_URL ?? 'https://api.kortix.com/v1',
    getToken: async () => apiKey,
  });

  try {
    const result = await kortix.workspace(workspaceId).connectors.profiles.list();
    return Response.json({
      connections: selectBindableConnections(result?.profiles, connector),
    });
  } catch {
    // A workspace with no connectors is the common case, not an error state.
    return Response.json({ connections: [] });
  }
}
