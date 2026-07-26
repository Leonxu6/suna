/**
 * Scope the local-dev auth cookie to the actual frontend port so running
 * multiple local frontends on the same host (localhost:3000, localhost:13737)
 * does not cause cross-app Supabase sign-out/session churn.
 *
 * Browsers scope cookies by host, not port. If two local apps on localhost use
 * the same cookie name and the same Supabase workspace, auth operations in one
 * app can overwrite or clear the other's session cookie.
 */
function resolveAuthCookieName() {
  const appUrl =
    process.env.KORTIX_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    process.env.PUBLIC_URL;

  if (!appUrl) return 'sb-kortix-auth-token';

  try {
    const url = new URL(appUrl);
    const isLocalhost = ['localhost', '127.0.0.1'].includes(url.hostname);
    const port = url.port;

    if (isLocalhost && port) {
      return `sb-kortix-auth-token-${port}`;
    }
  } catch {
    // Fall back to the historical cookie name.
  }

  return 'sb-kortix-auth-token';
}

export const KORTIX_SUPABASE_AUTH_COOKIE = resolveAuthCookieName();
