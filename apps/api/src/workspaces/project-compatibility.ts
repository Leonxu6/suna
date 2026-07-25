import type { MiddlewareHandler } from 'hono';

const KEY_ALIASES: Record<string, string> = {
  workspace_id: 'project_id',
  workspace_role: 'project_role',
  effective_workspace_role: 'effective_project_role',
};

const VALUE_ALIASES: Record<string, string> = {
  workspace: 'project',
  workspace_open: 'project_open',
  workspace_secret: 'project_secret',
};

export function toCanonicalWorkspacePath(pathname: string): string {
  return pathname.replace(
    /^\/v1\/executor\/projects(?=\/|$)/,
    '/v1/executor/workspaces',
  );
}

export function toDeprecatedProjectResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toDeprecatedProjectResponse);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? (VALUE_ALIASES[value] ?? value) : value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[KEY_ALIASES[key] ?? key] = toDeprecatedProjectResponse(nested);
  }
  return result;
}

export const projectCompatibilityMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Deprecation', 'true');
  c.header('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
  c.header('Link', '</v1/workspaces>; rel="successor-version"');

  const contentType = c.res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return;

  const body = await c.res.clone().json().catch(() => undefined);
  if (body === undefined) return;
  const headers = new Headers(c.res.headers);
  c.res = new Response(JSON.stringify(toDeprecatedProjectResponse(body)), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};
