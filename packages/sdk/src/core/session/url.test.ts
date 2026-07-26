import { expect, test } from 'bun:test';
import { isAppRouteUrl } from './url';

test('recognizes canonical Workspace URLs as app routes', () => {
  expect(isAppRouteUrl('http://localhost/workspaces/workspace-1')).toBe(true);
});
