/**
 * MANDATORY DECLARED AGENTS (flagged) — docs/specs/2026-07-05-agent-first-
 * config-unification.md §2.1/§3 Phase 2.
 *
 * `workspaceRequiresDeclaredAgents` decides whether a workspace is "subject" to
 * enforcement (platform-wide flag OR the workspace's own metadata stamp).
 * `resolveGovernedAgentGrant` is the pure resolution rule: for a non-subject
 * workspace it must be byte-for-byte identical to `grantFromLoadedAgents`
 * (today's back-compat behavior, untouched); for a subject workspace, an
 * undeclared agent — or a `default` sentinel with no resolvable declared
 * default_agent — is REJECTED with an explicit error rather than silently
 * granted the permissive null grant or silently default-denied-to-running.
 */
import { describe, expect, test } from 'bun:test';
import { getStarterFiles } from '@kortix/starter';
import { extractAgents, workspaceRequiresDeclaredAgents, resolveGovernedAgentGrant } from '../workspaces/agents';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../workspaces/triggers';
import { compileAgentConfig } from '../workspaces/lib/compile-agent-config';

function loadAgents(body: string) {
  return extractAgents(parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[workspace]\nname="t"\n${body}`));
}

describe('workspaceRequiresDeclaredAgents — subjectness', () => {
  test('platform flag off + no metadata stamp → not subject', () => {
    expect(workspaceRequiresDeclaredAgents({}, false)).toBe(false);
    expect(workspaceRequiresDeclaredAgents(null, false)).toBe(false);
    expect(workspaceRequiresDeclaredAgents(undefined, false)).toBe(false);
  });

  test('platform flag on → subject regardless of metadata', () => {
    expect(workspaceRequiresDeclaredAgents({}, true)).toBe(true);
    expect(workspaceRequiresDeclaredAgents(null, true)).toBe(true);
  });

  test('platform flag off but workspace.metadata.require_declared_agents === true → subject', () => {
    expect(workspaceRequiresDeclaredAgents({ require_declared_agents: true }, false)).toBe(true);
  });

  test('a truthy-but-not-literal-true value does NOT flip subjectness (strict ===)', () => {
    expect(workspaceRequiresDeclaredAgents({ require_declared_agents: 'true' }, false)).toBe(false);
    expect(workspaceRequiresDeclaredAgents({ require_declared_agents: 1 }, false)).toBe(false);
  });
});

describe('resolveGovernedAgentGrant — non-subject preserves today\'s exact behavior', () => {
  test('no [[agents]] section → ok, null grant (unrestricted, back-compat)', () => {
    const result = resolveGovernedAgentGrant('default', loadAgents(''), {
      subject: false,
      workspaceDefaultAgent: null,
    });
    expect(result).toEqual({ ok: true, grant: null });
  });

  test('governed workspace, unlisted concrete agent → ok, default-deny grant (unchanged v1 rule)', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
kortix_cli = ["workspace.trigger.create"]
`);
    const result = resolveGovernedAgentGrant('rogue-agent', loaded, {
      subject: false,
      workspaceDefaultAgent: null,
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'rogue-agent', connectors: [], kortixCli: [], env: [] },
    });
  });

  test('`default` sentinel under governance, non-subject → ok, null (non-binding, unchanged v1 rule)', () => {
    const loaded = loadAgents(`
[[agents]]
name = "veyris"
connectors = "all"
kortix_cli = "all"
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: false,
      workspaceDefaultAgent: null,
    });
    expect(result).toEqual({ ok: true, grant: null });
  });
});

describe('resolveGovernedAgentGrant — subject workspace rejects undeclared agents', () => {
  const loaded = loadAgents(`
[[agents]]
name = "support"
connectors = ["github"]
kortix_cli = ["workspace.cr.open"]

[[agents]]
name = "disabled-one"
enabled = false
`);

  test('declared, enabled agent → ok, its grant', () => {
    const result = resolveGovernedAgentGrant('support', loaded, {
      subject: true,
      workspaceDefaultAgent: 'support',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: ['workspace.cr.open'], env: 'all' },
    });
  });

  test('undeclared concrete agent → rejected with an explicit error (not null, not default-deny)', () => {
    const result = resolveGovernedAgentGrant('never-declared', loaded, {
      subject: true,
      workspaceDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AGENT_NOT_DECLARED');
      expect(result.error).toMatch(/not declared/i);
    }
  });

  test('a declared-but-disabled agent is rejected, same as undeclared', () => {
    const result = resolveGovernedAgentGrant('disabled-one', loaded, {
      subject: true,
      workspaceDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
  });

  test('workspace with zero [[agents]] declared at all → rejected (no adopt-to-govern escape hatch)', () => {
    const result = resolveGovernedAgentGrant('anything', loadAgents(''), {
      subject: true,
      workspaceDefaultAgent: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('resolveGovernedAgentGrant — subject workspace: `default` sentinel must resolve to a declared default_agent', () => {
  const loaded = loadAgents(`
[[agents]]
name = "support"
connectors = ["github"]
`);

  test('sentinel + a declared, enabled default_agent → ok, that agent\'s grant (not null)', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: 'support',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: [], env: 'all' },
    });
  });

  test('sentinel + no default_agent configured → rejected', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGENT_NOT_DECLARED');
  });

  test('sentinel + a default_agent naming an UNDECLARED agent → rejected', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: 'ghost-agent',
    });
    expect(result.ok).toBe(false);
  });
});

// kortix_version 2 — the runtime-wiring fix: extractAgents now reads a v2
// `agents:` map (not just v1's `[[agents]]` array), and the manifest's own
// top-level `default_agent` (captured on `LoadedAgents.defaultAgent`) backs
// `opts.workspaceDefaultAgent` when the DB-side workspace.metadata mirror isn't
// separately set — which is the common case for a v2 workspace, since nothing
// syncs the manifest's `default_agent` into workspace metadata today.
describe('resolveGovernedAgentGrant — subject workspace, kortix_version 2 manifest', () => {
  function loadV2(agentsBody: string, opts: { defaultAgent?: string } = {}) {
    const text = [
      'kortix_version: 2',
      `default_agent: ${opts.defaultAgent ?? 'support'}`,
      'workspace:',
      '  name: t',
      'agents:',
      agentsBody,
    ].join('\n');
    return extractAgents(parseManifestString(text, 'yaml', 'kortix.yaml'));
  }

  test('a concrete declared v2 agent is FOUND, not rejected / default-denied', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
    kortix_cli: [workspace.cr.open]
`);
    const result = resolveGovernedAgentGrant('support', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: ['workspace.cr.open'], env: [] },
    });
  });

  test('sentinel resolves via the MANIFEST\'s default_agent when workspace.metadata has none', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: null, // no DB-side mirror set — the common case for v2
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: [], env: [] },
    });
  });

  test('an explicit DB workspaceDefaultAgent still wins over the manifest\'s default_agent', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
  billing:
    secrets: [STRIPE_KEY]
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: 'billing',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'billing', connectors: [], kortixCli: [], env: ['STRIPE_KEY'] },
    });
  });

  test('an undeclared v2 agent is rejected, not default-denied', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
`);
    const result = resolveGovernedAgentGrant('never-declared', loaded, {
      subject: true,
      workspaceDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGENT_NOT_DECLARED');
  });
});

// P0 REGRESSION GUARD: POST /workspaces/provision (r1.ts) stamps
// `metadata.require_declared_agents = true` on every new workspace — so a fresh
// workspace is ALWAYS subject to this gate from birth, with no DB-side
// `metadata.default_agent` mirror set (sessions.ts's `workspaceDefaultAgent` is
// `undefined`/null the very first time). The starter it seeds
// (@kortix/starter, packages/starter/templates/base) MUST therefore ship a
// kortix_version 2 manifest with a `default_agent` that resolves — otherwise
// EVERY brand-new workspace's first session (agent 'default', the UI's
// no-explicit-agent path) is rejected with AGENT_NOT_DECLARED before a sandbox
// is ever provisioned. This exercises the REAL shipped starter (not a
// synthetic fixture) through the exact resolution rule sessions.ts calls.
describe('resolveGovernedAgentGrant — the actual shipped starter satisfies its own require_declared_agents stamp', () => {
  const starterFiles = getStarterFiles({ workspaceName: 'Acme Co', template: 'minimal' });
  const manifestFile = starterFiles.find((f) => f.path === 'kortix.yaml');

  test('the starter ships kortix.yaml (kortix_version 2), not a v1 kortix.toml', () => {
    expect(manifestFile).toBeDefined();
    expect(starterFiles.some((f) => f.path === 'kortix.toml')).toBe(false);
  });

  test('a first session with no explicit agent ("default") RESOLVES — ok:true, not AGENT_NOT_DECLARED', () => {
    const manifest = parseManifestString(manifestFile!.content, 'yaml', 'kortix.yaml');
    expect(manifest.schemaVersion).toBe(2);
    const loaded = extractAgents(manifest);

    // Mirrors r1.ts /workspaces/provision exactly: subject=true (the metadata
    // stamp), and no workspace.metadata.default_agent mirror set yet.
    const governed = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });

    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    expect(governed.grant).toEqual({
      agent: 'kortix',
      connectors: 'all',
      kortixCli: 'all',
      env: 'all',
    });
  });

  test('the starter\'s declared "kortix" agent also resolves when named explicitly', () => {
    const manifest = parseManifestString(manifestFile!.content, 'yaml', 'kortix.yaml');
    const loaded = extractAgents(manifest);
    const governed = resolveGovernedAgentGrant('kortix', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
  });

  test('the compiled v2 agent config reaches the session — no illegal-frontmatter compile error', () => {
    const manifest = parseManifestString(manifestFile!.content, 'yaml', 'kortix.yaml');
    const promptFiles: Record<string, string> = {};
    for (const f of starterFiles) {
      if (f.path === '.kortix/opencode/agents/kortix.md' || f.path === '.kortix/opencode/agents/memory-reflector.md') {
        promptFiles[f.path] = f.content;
      }
    }
    const compiled = compileAgentConfig(manifest.raw, 'opencode', promptFiles);
    expect(compiled).not.toBeNull();
    expect(compiled?.agent?.kortix?.mode).toBe('primary');
    expect(compiled?.agent?.kortix?.prompt).toContain('Kortix general knowledge worker');
    expect(compiled?.agent?.kortix?.prompt).not.toContain('---');
  });
});
