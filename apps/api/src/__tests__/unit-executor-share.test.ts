/**
 * Pure workspace-secret sharing logic — the 3 dashboard options + group grants.
 */
import { describe, expect, test } from 'bun:test';
import {
  intentToScope,
  isSecretUsableBy,
  isSessionVisibleTo,
  parseSharingIntent,
  scopeToIntent,
  sessionIntentToVisibility,
  visibilityToIntent,
  type SecretGrant,
} from '../executor/share';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const SALES = 'group-sales';

describe('parseSharingIntent — untrusted body → intent (HTTP gate)', () => {
  test('members keeps departments (groupIds) and members, dropping non-strings', () => {
    const out = parseSharingIntent(
      { mode: 'members', memberIds: ['u1', 42, null], groupIds: ['g1', 'g2', {}] },
      ALICE,
    );
    expect(out).toEqual({ mode: 'members', memberIds: ['u1'], groupIds: ['g1', 'g2'] });
  });

  test('department-only body survives (not silently downgraded to workspace)', () => {
    expect(parseSharingIntent({ mode: 'members', groupIds: ['g1'] }, ALICE)).toEqual({
      mode: 'members',
      memberIds: [],
      groupIds: ['g1'],
    });
  });

  test('private falls back ownerId to the calling user; workspace ignores lists', () => {
    expect(parseSharingIntent({ mode: 'private' }, ALICE)).toEqual({ mode: 'private', ownerId: ALICE });
    expect(parseSharingIntent({ mode: 'workspace', memberIds: ['x'] }, ALICE)).toEqual({ mode: 'workspace' });
  });
});

describe('isSecretUsableBy', () => {
  test('workspace scope → everyone', () => {
    expect(isSecretUsableBy('workspace', [], { userId: ALICE, groupIds: [] })).toBe(true);
  });

  test('restricted → only listed member', () => {
    const grants: SecretGrant[] = [{ principalType: 'member', principalId: ALICE }];
    expect(isSecretUsableBy('restricted', grants, { userId: ALICE, groupIds: [] })).toBe(true);
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: [] })).toBe(false);
  });

  test('restricted → group grant matches by membership', () => {
    const grants: SecretGrant[] = [{ principalType: 'group', principalId: SALES }];
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: [SALES] })).toBe(true);
    expect(isSecretUsableBy('restricted', grants, { userId: BOB, groupIds: ['group-eng'] })).toBe(false);
  });

  test('restricted with empty grants → nobody', () => {
    expect(isSecretUsableBy('restricted', [], { userId: ALICE, groupIds: [SALES] })).toBe(false);
  });
});

describe('intentToScope — the 3 options', () => {
  test('workspace wide', () => {
    expect(intentToScope({ mode: 'workspace' })).toEqual({ shareScope: 'workspace', grants: [] });
  });

  test('just me → restricted, single member grant', () => {
    expect(intentToScope({ mode: 'private', ownerId: ALICE })).toEqual({
      shareScope: 'restricted',
      grants: [{ principalType: 'member', principalId: ALICE }],
    });
  });

  test('select members (members + groups)', () => {
    expect(intentToScope({ mode: 'members', memberIds: [ALICE, BOB], groupIds: [SALES] })).toEqual({
      shareScope: 'restricted',
      grants: [
        { principalType: 'member', principalId: ALICE },
        { principalType: 'member', principalId: BOB },
        { principalType: 'group', principalId: SALES },
      ],
    });
  });

  test('select members with empty allow-list collapses to workspace-wide', () => {
    expect(intentToScope({ mode: 'members', memberIds: [], groupIds: [] })).toEqual({
      shareScope: 'workspace',
      grants: [],
    });
  });
});

describe('scopeToIntent — round-trip for the dashboard', () => {
  test('workspace', () => {
    expect(scopeToIntent('workspace', [])).toEqual({ mode: 'workspace' });
  });

  test('single member → private', () => {
    expect(scopeToIntent('restricted', [{ principalType: 'member', principalId: ALICE }])).toEqual({
      mode: 'private',
      ownerId: ALICE,
    });
  });

  test('multiple / group → members', () => {
    expect(
      scopeToIntent('restricted', [
        { principalType: 'member', principalId: ALICE },
        { principalType: 'group', principalId: SALES },
      ]),
    ).toEqual({ mode: 'members', memberIds: [ALICE], groupIds: [SALES] });
  });

  test('intent → scope → intent is stable', () => {
    for (const intent of [
      { mode: 'workspace' } as const,
      { mode: 'private', ownerId: ALICE } as const,
      { mode: 'members', memberIds: [ALICE, BOB], groupIds: [SALES] } as const,
    ]) {
      const { shareScope, grants } = intentToScope(intent);
      expect(intentToScope(scopeToIntent(shareScope, grants))).toEqual({ shareScope, grants });
    }
  });
});

describe('session sharing — default private; team-wide or select-members', () => {
  test('owner always sees their own session, regardless of visibility', () => {
    expect(isSessionVisibleTo('private', ALICE, [], { userId: ALICE, groupIds: [] })).toBe(true);
    expect(isSessionVisibleTo('private', ALICE, [], { userId: BOB, groupIds: [] })).toBe(false);
  });

  test('workspace visibility → every member', () => {
    expect(isSessionVisibleTo('workspace', ALICE, [], { userId: BOB, groupIds: [] })).toBe(true);
  });

  test('restricted → owner + member/group grants only', () => {
    const grants: SecretGrant[] = [
      { principalType: 'member', principalId: BOB },
      { principalType: 'group', principalId: SALES },
    ];
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: BOB, groupIds: [] })).toBe(true);
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: 'carol', groupIds: [SALES] })).toBe(true);
    expect(isSessionVisibleTo('restricted', ALICE, grants, { userId: 'carol', groupIds: [] })).toBe(false);
  });

  test('intent ⇄ visibility round-trips', () => {
    expect(sessionIntentToVisibility({ mode: 'workspace' })).toEqual({ visibility: 'workspace', grants: [] });
    expect(sessionIntentToVisibility({ mode: 'private', ownerId: ALICE })).toEqual({ visibility: 'private', grants: [] });
    // Empty members collapses to private (owner only).
    expect(sessionIntentToVisibility({ mode: 'members', memberIds: [] })).toEqual({ visibility: 'private', grants: [] });
    const members = sessionIntentToVisibility({ mode: 'members', memberIds: [BOB], groupIds: [SALES] });
    expect(members.visibility).toBe('restricted');
    expect(members.grants).toHaveLength(2);

    expect(visibilityToIntent('workspace', [])).toEqual({ mode: 'workspace' });
    expect(visibilityToIntent('private', [])).toEqual({ mode: 'private', ownerId: '' });
    expect(visibilityToIntent('restricted', members.grants)).toEqual({ mode: 'members', memberIds: [BOB], groupIds: [SALES] });
  });
});
