/**
 * Workspace access control + group grants + account-invite accept-side.
 *
 * Maps to spec §6 (WACC-*) and §5 invites accept-side (INV-*).
 *
 * Three surfaces, all real flows (no mocking, no direct DB):
 *  - Per-user workspace membership: GET/PUT/DELETE /workspaces/:id/access/:userId
 *    + email invite + the pending-invite queue (list/cancel/resend) for
 *    emails with no Kortix account yet.
 *  - Group grants: attach an IAM group to a workspace at a role
 *    (GET/POST/PATCH/DELETE /workspaces/:id/group-grants).
 *  - Account invites the recipient acts on:
 *    GET/accept/decline /account-invites/:inviteId.
 *
 * Workspace roles are manager|editor|user; member-management routes gate on
 * PROJECT_MEMBERS_MANAGE (admin-tier) — a workspace user/editor without manage
 * is denied. Source of truth: apps/api/src/workspaces/index.ts (access +
 * group-grants handlers) and apps/api/src/accounts/invites.ts.
 */
import { flow } from '../core/flow';

// ─── Per-user workspace access (list / grant / revoke) ─────────────────────

flow(
  'WACC-1',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces/:workspaceId/access',
      'PUT /v1/workspaces/:workspaceId/access/:userId',
      'DELETE /v1/workspaces/:workspaceId/access/:userId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.workspace();
    const member = await team.addMember('member');
    await ctx.step('OWNER grants member editor on workspace → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/workspaces/:workspaceId/access/:userId',
          { role: 'editor' },
          { params: { workspaceId: p.id, userId: member.userId! } },
        );
      r.status(200)
        .body()
        .has('$.workspace_role', 'editor')
        .has('$.effective_workspace_role', 'editor');
    });
    await ctx.step('GET access lists the granted member → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/workspaces/:workspaceId/access', { params: { workspaceId: p.id } });
      r.status(200).body().has('$.workspace_id', p.id).has('$.can_manage', true).exists('$.members');
    });
    await ctx.step('OWNER revokes the grant → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/workspaces/:workspaceId/access/:userId', {
        params: { workspaceId: p.id, userId: member.userId! },
      });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('NONMEMBER cannot read access → 404 (workspace not loadable)', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/workspaces/:workspaceId/access', { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
  },
);

flow(
  'WACC-3',
  {
    domain: 'workspaces',
    routes: ['PUT /v1/workspaces/:workspaceId/access/:userId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.workspace();
    const editor = await team.addMember('member');
    const target = await team.addMember('member');
    await ctx.step('OWNER grants the first member editor (write, not manage)', async () => {
      await team.grantWorkspaceRole(p.id, editor.userId!, 'editor');
    });
    await ctx.step('workspace editor cannot manage members → 403', async () => {
      // PROJECT_MEMBERS_MANAGE is admin-tier; editor has write but not manage.
      const r = await ctx.client
        .as(editor)
        .put(
          '/v1/workspaces/:workspaceId/access/:userId',
          { role: 'user' },
          { params: { workspaceId: p.id, userId: target.userId! } },
        );
      r.status([403, 404]);
    });
    await ctx.step('invalid role → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/workspaces/:workspaceId/access/:userId',
          { role: 'wizard' },
          { params: { workspaceId: p.id, userId: target.userId! } },
        );
      r.status(400);
    });
    await ctx.step('target who is not an account member → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          '/v1/workspaces/:workspaceId/access/:userId',
          { role: 'user' },
          { params: { workspaceId: p.id, userId: '00000000-0000-4000-a000-000000000000' } },
        );
      r.status(404);
    });
  },
);

flow(
  'WACC-4',
  {
    domain: 'workspaces',
    routes: ['DELETE /v1/workspaces/:workspaceId/access/:userId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.workspace();
    const member = await team.addMember('member');
    const admin = await team.addMember('admin');
    await ctx.step('grant then revoke a real member → 200', async () => {
      await team.grantWorkspaceRole(p.id, member.userId!, 'user');
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/workspaces/:workspaceId/access/:userId', {
        params: { workspaceId: p.id, userId: member.userId! },
      });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step("revoking an account admin's implicit access → 409", async () => {
      // Owners/admins hold implicit Manager on every workspace — there's no
      // explicit grant to remove.
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/workspaces/:workspaceId/access/:userId', {
        params: { workspaceId: p.id, userId: admin.userId! },
      });
      r.status(409);
    });
    await ctx.step('revoking a non-account-member → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/workspaces/:workspaceId/access/:userId', {
        params: { workspaceId: p.id, userId: '00000000-0000-4000-a000-000000000000' },
      });
      r.status(404);
    });
  },
);

// ─── Email invite to a workspace + pending-invite queue ────────────────────

flow(
  'WACC-5',
  {
    domain: 'workspaces',
    routes: [
      'POST /v1/workspaces/:workspaceId/access/invite',
      'GET /v1/workspaces/:workspaceId/access/pending-invites',
      'POST /v1/workspaces/:workspaceId/access/pending-invites/:inviteId/resend',
      'DELETE /v1/workspaces/:workspaceId/access/pending-invites/:inviteId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.workspace();
    const inviteEmail = `${ctx.fixtures.name('pacc-invitee')}@ke2e.kortix.test`.toLowerCase();
    let inviteId = '';
    await ctx.step('invite a brand-new email → 201 pending invitation', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { email: inviteEmail, role: 'editor' },
          { params: { workspaceId: p.id } },
        );
      r.status(201)
        .body()
        .has('$.status', 'invited')
        .has('$.workspace_role', 'editor')
        .exists('$.invite_id');
      inviteId = r.json<any>().invite_id;
    });
    await ctx.step('missing email → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { role: 'editor' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('invalid role → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { email: `${ctx.fixtures.name('x')}@ke2e.kortix.test`, role: 'wizard' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("pending-invites lists this workspace's queued invite → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/workspaces/:workspaceId/access/pending-invites', { params: { workspaceId: p.id } });
      r.status(200).body().exists('$.pending');
    });
    await ctx.step('resend the pending invite → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/pending-invites/:inviteId/resend',
          {},
          { params: { workspaceId: p.id, inviteId } },
        );
      r.status(200).body().has('$.ok', true).exists('$.expires_at');
    });
    await ctx.step('resend unknown invite → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/pending-invites/:inviteId/resend',
          {},
          { params: { workspaceId: p.id, inviteId: '00000000-0000-4000-a000-000000000000' } },
        );
      r.status(404);
    });
    await ctx.step('cancel the pending invite → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/workspaces/:workspaceId/access/pending-invites/:inviteId', {
          params: { workspaceId: p.id, inviteId },
        });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('cancel again (gone) → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/workspaces/:workspaceId/access/pending-invites/:inviteId', {
          params: { workspaceId: p.id, inviteId },
        });
      r.status(404);
    });
  },
);

// ─── Workspace group grants (IAM V2 bulk-access channel) ───────────────────

flow(
  'WACC-6',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces/:workspaceId/group-grants',
      'POST /v1/workspaces/:workspaceId/group-grants',
      'PATCH /v1/workspaces/:workspaceId/group-grants/:groupId',
      'DELETE /v1/workspaces/:workspaceId/group-grants/:groupId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const p = await team.workspace();
    let groupId = '';
    await ctx.step('create an IAM group to attach', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/iam/groups',
          { name: ctx.fixtures.name('grp') },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists('$.group_id');
      groupId = r.json<any>().group_id;
    });
    await ctx.step('list grants (empty) → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/workspaces/:workspaceId/group-grants', { params: { workspaceId: p.id } });
      r.status(200).body().exists('$.grants');
    });
    await ctx.step('attach group at editor → 201', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/group-grants',
          { group_id: groupId, role: 'editor' },
          { params: { workspaceId: p.id } },
        );
      r.status(201).body().has('$.group_id', groupId).has('$.role', 'editor');
    });
    await ctx.step('missing group_id → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/group-grants',
          { role: 'editor' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('attach a foreign/unknown group → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/group-grants',
          { group_id: '00000000-0000-4000-a000-000000000000', role: 'user' },
          { params: { workspaceId: p.id } },
        );
      r.status(404);
    });
    await ctx.step('PATCH role to user → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/workspaces/:workspaceId/group-grants/:groupId',
          { role: 'user' },
          { params: { workspaceId: p.id, groupId } },
        );
      r.status(200).body().has('$.role', 'user');
    });
    await ctx.step('PATCH unknown grant → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/workspaces/:workspaceId/group-grants/:groupId',
          { role: 'user' },
          { params: { workspaceId: p.id, groupId: '00000000-0000-4000-a000-000000000000' } },
        );
      r.status(404);
    });
    await ctx.step('detach the group → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/workspaces/:workspaceId/group-grants/:groupId', {
          params: { workspaceId: p.id, groupId },
        });
      r.status(200).body().has('$.ok', true);
    });
  },
);

// WACC-7 — resource grants are AGENT-ONLY (Marko, resource-model
// simplification). `agent` is the only member/department-scopable resource:
// assigning an agent lets the assignee USE it (and inherit its declared
// skills/connectors/secrets to USE, not edit). Skills and secrets are NO
// LONGER member-scopable resources — a POST with resource_type=skill|secret
// is rejected 400 (the guard runs before any config/DB load, so it needs no
// existing resource). Reading/listing/revoking pre-existing skill/secret
// grant rows still works (back-compat), but none can be CREATED here.
flow(
  'WACC-7',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces/:workspaceId/resource-grants',
      'POST /v1/workspaces/:workspaceId/resource-grants',
      'DELETE /v1/workspaces/:workspaceId/resource-grants/:grantId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const p = await team.workspace();
    const NONEXISTENT_GRANT = '00000000-0000-4000-a000-000000000000';

    let firstAgentId = '';
    await ctx.step('OWNER lists grantable resources and existing grants → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/workspaces/:workspaceId/resource-grants', { params: { workspaceId: p.id } });
      r.status(200).body().exists('$.resources').exists('$.grants');
      const agents = r.json<any>()?.resources?.agents ?? [];
      firstAgentId = agents[0]?.id ?? '';
    });

    // ── The core agent-only invariant: skill/secret creation is rejected ──
    await ctx.step('scoping a SECRET is rejected (agent-only) → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/workspaces/:workspaceId/resource-grants',
        {
          resource_type: 'secret',
          resource_id: 'ANY_SECRET',
          principal_type: 'member',
          principal_id: member.userId,
        },
        { params: { workspaceId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('scoping a SKILL is rejected (agent-only) → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/workspaces/:workspaceId/resource-grants',
        {
          resource_type: 'skill',
          resource_id: 'any-skill',
          principal_type: 'member',
          principal_id: member.userId,
        },
        { params: { workspaceId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('invalid resource type → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/workspaces/:workspaceId/resource-grants',
        {
          resource_type: 'database',
          resource_id: 'x',
          principal_type: 'member',
          principal_id: member.userId,
        },
        { params: { workspaceId: p.id } },
      );
      r.status(400);
    });

    // ── Agent happy path (only when the workspace declares an agent) ──
    let grantId = '';
    await ctx.step(
      'OWNER scopes an AGENT to an account member → 201 (skipped if no agent in config)',
      async () => {
        if (!firstAgentId) return; // bare workspace with no declared agents — nothing to scope
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/workspaces/:workspaceId/resource-grants',
          {
            resource_type: 'agent',
            resource_id: firstAgentId,
            principal_type: 'member',
            principal_id: member.userId,
          },
          { params: { workspaceId: p.id } },
        );
        r.status(201).body().exists('$.grant_id').has('$.resource_type', 'agent');
        grantId = r.json<any>().grant_id;
      },
    );

    await ctx.step(
      'OWNER deletes the agent grant → 200 (skipped if none was created)',
      async () => {
        if (!grantId) return;
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .del('/v1/workspaces/:workspaceId/resource-grants/:grantId', {
            params: { workspaceId: p.id, grantId },
          });
        r.status(200).body().has('$.ok', true);
      },
    );

    // Always exercise the DELETE route (coverage) with a nonexistent grant.
    await ctx.step('deleting a nonexistent grant → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/workspaces/:workspaceId/resource-grants/:grantId', {
          params: { workspaceId: p.id, grantId: grantId || NONEXISTENT_GRANT },
        });
      // If a real grant was created+deleted above, re-deleting it is 404 too.
      r.status(404);
    });
  },
);

// ─── Account-invite accept side (recipient-driven) ───────────────────────
//
// A clean accept/decline needs the invited user to sign in as the addressed
// email — the suite synthesizes members but the account-invite (no Kortix
// user yet) recipient isn't a provisioned principal, so we cover the
// recipient-facing routes via real invite creation + the describe/error
// boundaries that don't require being the addressee.

flow(
  'INV-3',
  {
    domain: 'workspaces',
    routes: ['GET /v1/account-invites/:inviteId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const inviteEmail = `${ctx.fixtures.name('inv3')}@ke2e.kortix.test`.toLowerCase();
    let inviteId = '';
    await ctx.step('create a pending account invite (new email)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/members',
          { email: inviteEmail, role: 'member' },
          { params: { accountId: team.id } },
        );
      r.status(201).body().has('$.status', 'pending').exists('$.invite_id');
      inviteId = r.json<any>().invite_id;
    });
    await ctx.step(
      'describe as a non-addressee → 200 but identifying fields redacted',
      async () => {
        // OWNER isn't the invited email → email_matches_caller:false, no account leak.
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/account-invites/:inviteId', { params: { inviteId } });
        r.status(200).body().has('$.email_matches_caller', false).has('$.email', null);
      },
    );
    await ctx.step('describe unknown invite → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/account-invites/:inviteId', {
        params: { inviteId: '00000000-0000-4000-a000-000000000000' },
      });
      r.status(404);
    });
    await ctx.step('ANON cannot describe → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/account-invites/:inviteId', { params: { inviteId } });
      r.status(401);
    });
  },
);

flow(
  'INV-4',
  {
    domain: 'workspaces',
    routes: ['POST /v1/account-invites/:inviteId/accept'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const inviteEmail = `${ctx.fixtures.name('inv4')}@ke2e.kortix.test`.toLowerCase();
    let inviteId = '';
    await ctx.step('create a pending account invite', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/members',
          { email: inviteEmail, role: 'member' },
          { params: { accountId: team.id } },
        );
      r.status(201);
      inviteId = r.json<any>().invite_id;
    });
    await ctx.step('accept as the wrong email → 403', async () => {
      // OWNER's email != the invited address → the invite refuses.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } });
      r.status(403);
    });
    await ctx.step('accept an unknown invite → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/account-invites/:inviteId/accept',
          {},
          { params: { inviteId: '00000000-0000-4000-a000-000000000000' } },
        );
      r.status(404);
    });
    await ctx.step('ANON cannot accept → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } });
      r.status(401);
    });
  },
);

flow(
  'INV-5',
  {
    domain: 'workspaces',
    routes: ['POST /v1/account-invites/:inviteId/decline'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const inviteEmail = `${ctx.fixtures.name('inv5')}@ke2e.kortix.test`.toLowerCase();
    let inviteId = '';
    await ctx.step('create a pending account invite', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/members',
          { email: inviteEmail, role: 'member' },
          { params: { accountId: team.id } },
        );
      r.status(201);
      inviteId = r.json<any>().invite_id;
    });
    await ctx.step('decline as the wrong email → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/account-invites/:inviteId/decline', {}, { params: { inviteId } });
      r.status(403);
    });
    await ctx.step('decline an unknown invite → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/account-invites/:inviteId/decline',
          {},
          { params: { inviteId: '00000000-0000-4000-a000-000000000000' } },
        );
      r.status(404);
    });
    await ctx.step('ANON cannot decline → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/account-invites/:inviteId/decline', {}, { params: { inviteId } });
      r.status(401);
    });
  },
);

// WACC-2 — workspace email invite. A brand-new email (no Kortix account yet)
// creates an account invitation carrying a bootstrap workspace grant → 201
// {status:"invited"}. Validation (missing email / bad role → 400) and the
// manage gate (non-member → 404, workspace not loadable) are enforced.
flow(
  'WACC-2',
  { domain: 'workspaces', routes: ['POST /v1/workspaces/:workspaceId/access/invite'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.workspace();
    await ctx.step('invite an email with no Kortix account → 201 invitation created', async () => {
      const email = `${ctx.fixtures.name('invitee')}@example.com`.toLowerCase();
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { email, role: 'editor' },
          { params: { workspaceId: p.id } },
        );
      r.status(201)
        .body()
        .has('$.status', 'invited')
        .has('$.workspace_role', 'editor')
        .exists('$.invite_id');
    });
    await ctx.step('missing email → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { role: 'editor' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('invalid role → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { email: 'nope@example.com', role: 'superboss' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('NONMEMBER cannot invite → 403 (not a member of the account)', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/workspaces/:workspaceId/access/invite',
          { email: 'stranger@example.com', role: 'user' },
          { params: { workspaceId: p.id } },
        );
      r.status(403);
    });
  },
);
