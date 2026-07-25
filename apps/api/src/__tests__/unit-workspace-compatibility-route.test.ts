import { describe, expect, test } from 'bun:test';
import { app } from '../index';

describe('deprecated executor project route', () => {
  test('forwards to the canonical workspace route and adds deprecation headers', async () => {
    const response = await app.request(
      '/v1/executor/projects/ws-1/catalog',
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Deprecation')).toBe('true');
    expect(response.headers.get('Sunset')).toBe(
      'Wed, 31 Dec 2026 23:59:59 GMT',
    );
    expect(response.headers.get('Link')).toBe(
      '</v1/workspaces>; rel="successor-version"',
    );
    expect(await response.json()).toEqual({
      error: true,
      message: 'Missing authentication token',
      status: 401,
    });
  });
});
