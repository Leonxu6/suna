// Exact UI flow with a real user JWT. WORKSPACE_ID + CAP come from the environment.
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

interface SessionResponse {
  session_id?: string;
}

interface SandboxResponse {
  external_id?: string;
  status?: string;
}

interface HealthResponse {
  runtimeReady?: boolean;
  err?: string;
}

interface EnsureResponse {
  ensure?: { reason?: string };
  opencode_session_id?: string;
}

const JWT = requireEnv('E2E_USER_JWT');
const H = { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' };
const BASE = 'http://localhost:8008';
const WORKSPACE_ID =
  process.env.WORKSPACE_ID || process.env.PID || '4e576413-8140-438c-bdff-d9a449a8cbf8';
const CAP = Number(process.env.CAP || 200000); // ms
const now = () => Date.now();

const t0 = now();
const ses = (await (
  await fetch(`${BASE}/v1/workspaces/${WORKSPACE_ID}/sessions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ branch_already_created: false }),
  })
).json()) as SessionResponse;
if (!ses.session_id) {
  console.log('CREATE_FAILED:', JSON.stringify(ses).slice(0, 300));
  process.exit(1);
}
console.log(`session-created +${now() - t0}ms (${ses.session_id})`);

// poll sandbox row like the FE
let sbx: SandboxResponse | null = null;
while (now() - t0 < CAP) {
  sbx = await (
    await fetch(`${BASE}/v1/workspaces/${WORKSPACE_ID}/sessions/${ses.session_id}/sandbox`, {
      headers: H,
    })
  )
    .json()
    .catch(() => null);
  if (sbx?.status === 'active' && sbx?.external_id) break;
  await Bun.sleep(150);
}
console.log(
  `sandbox-active +${now() - t0}ms (${sbx?.external_id ?? '-'}) status=${sbx?.status ?? '-'}`,
);
if (!sbx?.external_id) {
  console.log('NO_SANDBOX');
  process.exit(1);
}

// poll health through the same proxy the FE uses
const base = `${BASE}/v1/p/${sbx.external_id}/8000`;
let ready = false;
let lastHealth: HealthResponse | null = null;
while (now() - t0 < CAP) {
  try {
    lastHealth = (await (
      await fetch(`${base}/kortix/health`, { headers: H, signal: AbortSignal.timeout(3000) })
    ).json()) as HealthResponse;
    if (lastHealth?.runtimeReady) {
      ready = true;
      break;
    }
  } catch (error: unknown) {
    lastHealth = {
      err: String(error instanceof Error ? error.name : error).slice(0, 40),
    };
  }
  await Bun.sleep(250);
}
console.log(
  `runtime-ready=${ready} +${now() - t0}ms health=${JSON.stringify(lastHealth).slice(0, 220)}`,
);

if (ready) {
  const e = (await (
    await fetch(
      `${BASE}/v1/workspaces/${WORKSPACE_ID}/sessions/${ses.session_id}/ensure-opencode`,
      { method: 'POST', headers: H, body: '{}' },
    )
  ).json()) as EnsureResponse;
  console.log(
    `ensure +${now() - t0}ms (${e?.ensure?.reason ?? '?'}) pin=${(e?.opencode_session_id ?? '').slice(0, 12)}`,
  );
  console.log(`USABLE in ${now() - t0}ms  sbx=${sbx.external_id}`);
} else {
  console.log(`STUCK after ${now() - t0}ms  sbx=${sbx.external_id}`);
}
console.log(`SBX=${sbx.external_id}`);
process.exit(ready ? 0 : 2);
