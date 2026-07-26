/**
 * Cost pass-through: aggregate `GET {upstream}/workspaces/:id/gateway/sessions`
 * across every workspace the caller owns (via the SDK's
 * `kortix.workspace(id).gateway.sessions()`), apply `COST_MARKUP`, and return
 * both the raw Kortix cost and the marked-up "your price" per session — the
 * re-billing surface a real wrapper would show its own users. Rendered by
 * `src/app/usage/page.tsx`. `createScopedKortix` (`@kortix/sdk/server`) is
 * used instead of the shared `configureKortix()` singleton because this route
 * serves concurrent requests carrying different end users' identities on one
 * process — each call gets its own isolated config via `AsyncLocalStorage`.
 */

import type { GatewaySessionStat } from '@kortix/sdk';
import { createScopedKortix } from '@kortix/sdk/server';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isValidWorkspaceId, listOwnedWorkspaces } from '@/server/users';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(/\/+$/, '');
}

function markupMultiplier(): number {
  const n = Number(process.env.COST_MARKUP ?? 1.2);
  return Number.isFinite(n) && n > 0 ? n : 1.2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });

  const markup = markupMultiplier();
  const upstream = upstreamBase();
  // listOwnedWorkspaces already UUID-filters, but re-assert at the call site:
  // these ids come from a file and are interpolated into upstream URLs.
  const workspaceIds = listOwnedWorkspaces(session.userId).filter(isValidWorkspaceId);

  const kortix = createScopedKortix({ backendUrl: upstream, getToken: async () => apiKey });

  const workspaces = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      // Explicit per-item barrier right before the call — the list is already
      // UUID-filtered above, but static analysis needs the guard on the same
      // control path as the request.
      if (!isValidWorkspaceId(workspaceId)) {
        return { workspaceId, sessions: [], error: 'invalid workspace id' };
      }
      try {
        const data = await kortix.workspace(workspaceId).gateway.sessions();
        const sessions: GatewaySessionStat[] = Array.isArray(data?.sessions) ? data.sessions : [];
        return {
          workspaceId,
          sessions: sessions.map((s) => ({
            ...s,
            billed_cost: round2((s.total_cost ?? 0) * markup),
          })),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'request failed';
        return { workspaceId, sessions: [], error: message };
      }
    }),
  );

  const totals = workspaces.reduce(
    (acc, p) => {
      for (const s of p.sessions) {
        acc.raw += s.total_cost ?? 0;
        acc.billed += s.billed_cost ?? 0;
      }
      return acc;
    },
    { raw: 0, billed: 0 },
  );

  return Response.json({
    markup,
    totals: { raw: round2(totals.raw), billed: round2(totals.billed) },
    workspaces,
  });
}
