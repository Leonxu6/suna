import { spawn } from 'node:child_process';

function normalizeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function openInBrowser(value: string): boolean {
  const url = normalizeBrowserUrl(value);
  if (!url) return false;

  try {
    const child =
      process.platform === 'darwin'
        ? spawn('/usr/bin/open', ['--', url], { stdio: 'ignore', detached: true })
        : process.platform === 'win32'
          ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
              stdio: 'ignore',
              detached: true,
            })
          : spawn('/usr/bin/xdg-open', ['--', url], { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
