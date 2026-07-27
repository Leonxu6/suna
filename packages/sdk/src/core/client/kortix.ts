import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
/**
 * createKortix — the single opinionated entry point to the Kortix data layer.
 *
 * One client. Every action a method. The host app imports ONLY from `@kortix/sdk`
 * — never `@opencode-ai/sdk`, never `backendApi`/`authenticatedFetch` directly.
 *
 *   const kortix = createKortix({ getToken });
 *   await kortix.workspaces.list();
 *   await kortix.workspace(pid).secrets.upsert({ name, value });
 *   const s = kortix.session(pid, sid);
 *   await s.start();
 *   s.runtime.session.prompt({ sessionID: sid, parts });   // typed opencode, via the SDK
 *
 * REST methods are direct references to the platform client, so they keep their
 * exact types with zero re-typing. The `workspace()`/`session()` handles bind ids
 * for ergonomics. Reactive data still comes from `@kortix/sdk/react` hooks.
 */
import * as F from '../files/client';
import { getClient, getClientForUrl } from '../runtime/client';
import { ApiError } from '../http/api/errors';
import { type KortixPlatformConfig, configureKortix, platformConfig } from '../http/config';
import * as P from '../rest/workspaces-client';
import { getSessionHealth } from '../session/health';
import { type SubdomainUrlOptions, proxyLocalhostUrl, rewriteLocalhostUrl } from '../session/url';
import { setCurrentRuntime } from '../session/current-runtime';
import {
  clearSessionRuntime,
  getSessionRuntime,
  type SessionRuntimeEntry,
} from '../session/session-runtime-registry';
import { getSandboxUrlForExternalId } from '../session/server-store/url-helpers';
import {
  openEventStream,
  type EventStreamHandle,
  type OpenCodeEvent,
} from '../stream/event-stream';

/** A model the agent can run, as the opencode runtime identifies it. */
export type SessionModel = { providerID: string; modelID: string };

/** The opencode runtime client for the currently-active sandbox (set by the host). */
function runtime(): OpencodeClient {
  return getClient();
}

/**
 * Thrown by a session handle's runtime-scoped operations (`.runtime`,
 * `.health()`, `.previewUrl()`, `.proxyUrl()`) when called before the handle
 * has resolved its own sandbox runtime. These never fall back to whatever
 * sandbox happens to be globally active (a different session's runtime) —
 * the caller must resolve THIS handle's runtime first.
 */
/**
 * Dedupes concurrent `ensureReady()` calls that would otherwise both drive a
 * `/start` long-poll for the SAME (workspaceId, sessionId) — e.g. two session
 * handles for the same session (or the facade racing the React `useSession`
 * hook) both calling `ensureReady()`/`start()` before either has resolved a
 * runtime. Keyed by `${workspaceId}\n${sessionId}` (not the process-global
 * "active runtime" — every other handle for a DIFFERENT session gets its own
 * entry and is unaffected). Cleared on settle (success or failure) so a
 * transient failure doesn't wedge the key — the next call issues a fresh
 * `/start` instead of replaying a stale rejected promise forever.
 */
const inFlightSessionStarts = new Map<string, Promise<SessionRuntimeEntry>>();

export class SessionNotReadyError extends Error {
  constructor(action: string) {
    super(
      `Session runtime not ready — call \`await session.ensureReady()\` (it drives \`start()\` to completion and resolves this session's own sandbox runtime) before calling \`${action}\`.`,
    );
    this.name = 'SessionNotReadyError';
  }
}

export function createKortix(config: KortixPlatformConfig, opts?: { global?: boolean }) {
  // Wire the platform seam once. All wrapped functions read it.
  //
  // `opts.global === false` (used by `@kortix/sdk/server`'s `createScopedKortix`)
  // skips the process-wide write entirely — that caller relies solely on the
  // `AsyncLocalStorage` scope `createScopedKortix` wraps every method call in,
  // so this returned facade never touches (or is affected by) the module-global
  // singleton other concurrent `createKortix()` calls in the same process share.
  configureKortix(config, opts);

  /**
   * Parse `backendUrl` for its port (used by the subdomain preview scheme).
   * `backendUrl` is normally absolute, but the BFF pattern — a Next.js API
   * route (or any same-origin proxy) fronting the real Kortix API — legitimately
   * configures it as a relative path like `/api/kortix`. `new URL()` throws on
   * a bare relative string (no base to resolve against). In a browser that's
   * recoverable: resolve it against the page's own origin. Server-side there
   * is no implicit origin, so a relative `backendUrl` is a real misconfiguration
   * — fail loudly instead of silently defaulting to port 80.
   */
  function parseBackendUrlForPort(apiBaseUrl: string): URL | null {
    try {
      return new URL(apiBaseUrl);
    } catch {
      if (typeof window !== 'undefined' && window.location?.origin) {
        try {
          return new URL(apiBaseUrl, window.location.origin);
        } catch {
          return null;
        }
      }
      throw new ApiError(
        `Kortix SDK: backendUrl must be an absolute URL outside the browser (got ${JSON.stringify(apiBaseUrl)}). Relative paths like "/api/kortix" only resolve against a page origin — configure an absolute backendUrl for server-side hosts.`,
        { code: 'INVALID_BACKEND_URL' },
      );
    }
  }

  /**
   * Resolve the proxy/preview URL context (sandboxId + api base) from config +
   * a THIS-handle's own resolved sandbox id, so a session's `previewUrl`/
   * `proxyUrl` never make the host name a sandbox — and never reads whichever
   * sandbox happens to be globally active (which may belong to a different
   * session handle).
   */
  function resolvePreviewOptsForSandbox(sandboxId: string): SubdomainUrlOptions {
    // Read the LIVE platform config, not the `config` captured at
    // `createKortix()` time: a host may re-point the seam after creation
    // (calling `configureKortix()` again — e.g. the whitelabel app switching
    // its `backendUrl` to a same-origin BFF proxy once it learns wrapper mode
    // is on), and preview/proxy URLs must follow the reconfigured base like
    // every other call path already does.
    const apiBaseUrl = platformConfig().backendUrl ?? config.backendUrl;
    let backendPort = 80;
    const u = parseBackendUrlForPort(apiBaseUrl);
    if (u) {
      backendPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    }
    return { sandboxId, backendPort, apiBaseUrl };
  }

  /** Account-scoped operations. */
  const accounts = {
    list: P.listAccounts,
    get: P.getAccount,
    create: P.createAccount,
    updateName: P.updateAccountName,
    leave: P.leaveAccount,
    members: P.listAccountMembers,
    invite: P.inviteAccountMember,
    removeMember: P.removeAccountMember,
    updateMemberRole: P.updateAccountMemberRole,
    invites: P.listAccountInvites,
    /** Cancel a pending account invite (accountId still known/scoped). */
    cancelInvite: P.cancelAccountInvite,
    /** Resend a pending account invite (accountId still known/scoped). */
    resendInvite: P.resendAccountInvite,
    /** CLI PAT minting — account-scoped personal access tokens (`kortix_pat_...`). */
    tokens: {
      list: P.listAccountTokens,
      create: P.createAccountToken,
      revoke: P.revokeAccountToken,
    },
    /** Enterprise audit log — events + CSV/JSONL export + SIEM webhooks. */
    audit: {
      log: P.listAccountAudit,
      export: P.exportAccountAudit,
      webhooks: {
        list: P.listAccountAuditWebhooks,
        create: P.createAccountAuditWebhook,
        update: P.updateAccountAuditWebhook,
        remove: P.removeAccountAuditWebhook,
      },
    },
  };

  /**
   * Billing read surface — credits, subscription, tier, and transaction
   * history for entitlement-gating + a billing/usage UI. Checkout/portal/
   * credit-purchase/subscription MUTATIONS stay app-owned (Stripe flows) —
   * this is reads only.
   */
  const billing = {
    accountState: P.getAccountState,
    accountStateMinimal: P.getAccountStateMinimal,
    transactions: P.listBillingTransactions,
    transactionsSummary: P.getBillingTransactionsSummary,
    creditBreakdown: P.getBillingCreditBreakdown,
    usageHistory: P.getBillingUsageHistory,
    /** Usage rollup (/v1/usage) — supports group_by 'end_user_ref' for wrappers. */
    usageRollup: P.getUsageRollup,
    tierConfigurations: P.getBillingTierConfigurations,

    /** Stripe checkout — start a subscription and confirm it post-redirect. */
    checkout: {
      createSession: (input: Parameters<typeof P.createCheckoutSession>[0]) =>
        P.createCheckoutSession(input),
      confirmSession: (sessionId: string, accountId?: string) =>
        P.confirmCheckoutSession(sessionId, accountId),
    },

    /** Manage an existing subscription (portal, cancel/reactivate, downgrade). */
    subscription: {
      createPortalSession: (returnUrl: string, accountId?: string) =>
        P.createPortalSession(returnUrl, accountId),
      cancel: (feedback?: string, accountId?: string) => P.cancelSubscription(feedback, accountId),
      reactivate: (accountId?: string) => P.reactivateSubscription(accountId),
      scheduleDowngrade: (targetTierKey: string, commitmentType?: string, accountId?: string) =>
        P.scheduleDowngrade(targetTierKey, commitmentType, accountId),
      cancelScheduledChange: (accountId?: string) => P.cancelScheduledChange(accountId),
      prorationPreview: (newPriceId: string, accountId?: string) =>
        P.getProrationPreview(newPriceId, accountId),
    },

    /** One-off credit purchases + recurring auto-topup configuration. */
    credits: {
      purchase: (input: Parameters<typeof P.purchaseCredits>[0]) => P.purchaseCredits(input),
      autoTopupSettings: (accountId?: string) => P.getAutoTopupSettings(accountId),
      configureAutoTopup: (input: Parameters<typeof P.configureAutoTopup>[0]) =>
        P.configureAutoTopup(input),
    },
  };

  /**
   * Account-invite lifecycle reached by invite token alone — accept/decline/
   * describe are called by the invitee (who may not be an account member, or
   * even signed into this account, yet), so they take only `inviteId` and
   * genuinely don't fit account- or workspace-scoping.
   */
  const accountInvites = {
    describe: P.describeAccountInvite,
    accept: P.acceptAccountInvite,
    decline: P.declineAccountInvite,
  };

  /** Top-level workspace operations (not bound to an id). */
  const workspaces = {
    list: P.listWorkspaces,
    listForAccount: P.listWorkspacesForAccount,
    get: P.getWorkspace,
    detail: P.getWorkspaceDetail,
    create: P.createWorkspace,
    /** Create a workspace backed by a brand-new Kortix-managed GitHub repo. */
    createRepo: P.createWorkspaceRepo,
    provision: P.provisionWorkspace,
    update: P.updateWorkspace,
    archive: P.archiveWorkspace,
    llmCatalog: P.getWorkspaceLlmCatalog,
    modelPicker: P.getWorkspaceModelPicker,
    sandboxHealth: P.getWorkspaceSandboxHealth,
    sandboxTemplates: P.listWorkspaceSandboxTemplates,
    sessions: P.listWorkspaceSessions,
    createSession: P.createWorkspaceSession,
  };

  type LegacyProject = Omit<P.KortixWorkspace, 'workspace_id'> & {
    project_id: string;
    workspace_id?: string;
  };
  const toLegacyProject = (workspace: P.KortixWorkspace): LegacyProject => {
    const { workspace_id, ...rest } = workspace;
    return { ...rest, project_id: workspace_id, workspace_id };
  };

  /** @deprecated Use `workspaces`. */
  const projects = {
    ...workspaces,
    list: async () => (await P.listWorkspaces()).map(toLegacyProject),
    listForAccount: async (accountId?: string) =>
      (await P.listWorkspacesForAccount(accountId)).map(toLegacyProject),
    get: async (projectId: string, options?: Parameters<typeof P.getWorkspace>[1]) =>
      toLegacyProject(await P.getWorkspace(projectId, options)),
    create: async (input: Parameters<typeof P.createWorkspace>[0]) =>
      toLegacyProject(await P.createWorkspace(input)),
    createRepo: async (input: Parameters<typeof P.createWorkspaceRepo>[0]) =>
      toLegacyProject(await P.createWorkspaceRepo(input)),
    provision: async (input: Parameters<typeof P.provisionWorkspace>[0]) =>
      toLegacyProject(await P.provisionWorkspace(input)),
    update: async (
      projectId: string,
      input: Parameters<typeof P.updateWorkspace>[1],
    ) => toLegacyProject(await P.updateWorkspace(projectId, input)),
  };

  /** GitHub App installation + repository linking — account-scoped, not workspace-scoped. */
  const github = {
    linkRepository: P.linkRepository,
    getInstallation: P.getGitHubInstallation,
    listInstallations: P.listGitHubInstallations,
    listLinkableInstallations: P.listLinkableGitHubInstallations,
    listRepositories: P.listGitHubRepositories,
    listRepositoryBranches: P.listGitHubRepositoryBranches,
    linkInstallation: P.linkGitHubInstallation,
    saveInstallation: P.saveGitHubInstallation,
    deleteInstallation: P.deleteGitHubInstallation,
  };

  /** Public share links for a sandbox port (`/v1/p/share`) — sandbox-scoped, not workspace-scoped. */
  const sandboxShares = {
    list: P.listSandboxShares,
    create: P.createSandboxShare,
    revoke: P.revokeSandboxShare,
  };

  /** Deployment-wide flag: is the easy-connect (Pipedream) provider configured? Not workspace-scoped. */
  const connectStatus = P.getConnectStatus;

  /**
   * Public marketplace catalog browse (`/v1/marketplace/*`) — top-level and
   * distinct from `workspace(id).marketplace`, which is install-scoped (commits
   * an item onto a specific workspace's branch). This is read-only browsing +
   * the authed "add a marketplace source" surface.
   */
  const marketplace = {
    items: (options?: Parameters<typeof P.listMarketplaceCatalogItems>[0]) =>
      P.listMarketplaceCatalogItems(options),
    item: (id: string) => P.getMarketplaceCatalogItem(id),
    itemFile: (id: string, path: string) => P.getMarketplaceCatalogItemFile(id, path),
    marketplaces: () => P.listMarketplaces(),
    featured: () => P.listFeaturedMarketplaces(),
    sources: {
      list: () => P.listMarketplaceSources(),
      add: (input: Parameters<typeof P.addMarketplaceSource>[0]) => P.addMarketplaceSource(input),
      remove: (id: string) => P.removeMarketplaceSource(id),
    },
  };

  /** Id-bound handle for a single workspace: every sub-resource, workspaceId pre-applied. */
  function workspace(workspaceId: string) {
    return {
      get: (opts?: Parameters<typeof P.getWorkspace>[1]) => P.getWorkspace(workspaceId, opts),
      detail: () => P.getWorkspaceDetail(workspaceId),
      update: (input: Parameters<typeof P.updateWorkspace>[1]) => P.updateWorkspace(workspaceId, input),
      archive: () => P.archiveWorkspace(workspaceId),
      llmCatalog: () => P.getWorkspaceLlmCatalog(workspaceId),
      modelPicker: () => P.getWorkspaceModelPicker(workspaceId),
      sandboxHealth: () => P.getWorkspaceSandboxHealth(workspaceId),
      onboardingComplete: (...a: DropFirst<Parameters<typeof P.setWorkspaceOnboardingComplete>>) =>
        P.setWorkspaceOnboardingComplete(workspaceId, ...a),

      /** Workspace-scoped CLI PATs (auto-minted at session-create as `KORTIX_TOKEN`; can also be minted by hand). */
      tokens: {
        list: () => P.listWorkspaceCliTokens(workspaceId),
        create: (input?: Parameters<typeof P.createWorkspaceCliToken>[1]) =>
          P.createWorkspaceCliToken(workspaceId, input),
        revoke: (tokenId: string) => P.revokeWorkspaceCliToken(workspaceId, tokenId),
      },

      /** Agent-minted setup links — hand a human a link to enter a secret value or 1-click connect an app. */
      setupLinks: {
        requestSecret: (input: Parameters<typeof P.requestWorkspaceSecret>[1]) =>
          P.requestWorkspaceSecret(workspaceId, input),
        requestConnector: (input: Parameters<typeof P.requestWorkspaceConnector>[1]) =>
          P.requestWorkspaceConnector(workspaceId, input),
      },

      /** Validate a `kortix.yaml` (or legacy `kortix.toml`) manifest's raw text server-side — format is auto-resolved from the workspace's manifest path (same schema `kortix ship`/CR-merge use). */
      validateManifest: (raw: string) => P.validateWorkspaceManifest(workspaceId, raw),

      /** Mint a fresh scoped git push token for a managed workspace (409 for BYO repos). */
      gitToken: () => P.getWorkspaceGitToken(workspaceId),

      secrets: {
        list: () => P.listWorkspaceSecrets(workspaceId),
        upsert: (input: Parameters<typeof P.upsertWorkspaceSecret>[1]) =>
          P.upsertWorkspaceSecret(workspaceId, input),
        remove: (name: string) => P.deleteWorkspaceSecret(workspaceId, name),
        setPersonal: (...a: DropFirst<Parameters<typeof P.setPersonalWorkspaceSecret>>) =>
          P.setPersonalWorkspaceSecret(workspaceId, ...a),
        removePersonal: (name: string) => P.deletePersonalWorkspaceSecret(workspaceId, name),
        setGitCredential: (input: Parameters<typeof P.upsertWorkspaceGitCredential>[1]) =>
          P.upsertWorkspaceGitCredential(workspaceId, input),
        /** Device-code OAuth flow to connect a subscription-backed provider (e.g. ChatGPT). */
        startProviderOAuth: (...a: DropFirst<Parameters<typeof P.startWorkspaceProviderOAuth>>) =>
          P.startWorkspaceProviderOAuth(workspaceId, ...a),
        pollProviderOAuth: (...a: DropFirst<Parameters<typeof P.pollWorkspaceProviderOAuth>>) =>
          P.pollWorkspaceProviderOAuth(workspaceId, ...a),
      },

      access: {
        list: () => P.listWorkspaceAccess(workspaceId),
        invite: (...a: DropFirst<Parameters<typeof P.inviteWorkspaceMember>>) =>
          P.inviteWorkspaceMember(workspaceId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateWorkspaceAccess>>) =>
          P.updateWorkspaceAccess(workspaceId, ...a),
        revoke: (userId: string) => P.revokeWorkspaceAccess(workspaceId, userId),
        pendingInvites: () => P.listPendingWorkspaceInvites(workspaceId),
        resendInvite: (...a: DropFirst<Parameters<typeof P.resendPendingWorkspaceInvite>>) =>
          P.resendPendingWorkspaceInvite(workspaceId, ...a),
        revokeInvite: (...a: DropFirst<Parameters<typeof P.revokePendingWorkspaceInvite>>) =>
          P.revokePendingWorkspaceInvite(workspaceId, ...a),
        requests: () => P.listWorkspaceAccessRequests(workspaceId),
        approveRequest: (...a: DropFirst<Parameters<typeof P.approveWorkspaceAccessRequest>>) =>
          P.approveWorkspaceAccessRequest(workspaceId, ...a),
        rejectRequest: (...a: DropFirst<Parameters<typeof P.rejectWorkspaceAccessRequest>>) =>
          P.rejectWorkspaceAccessRequest(workspaceId, ...a),
        groupGrants: () => P.listWorkspaceGroupGrants(workspaceId),
        attachGroupGrant: (...a: DropFirst<Parameters<typeof P.attachGroupToWorkspace>>) =>
          P.attachGroupToWorkspace(workspaceId, ...a),
        updateGroupGrant: (...a: DropFirst<Parameters<typeof P.updateWorkspaceGroupGrant>>) =>
          P.updateWorkspaceGroupGrant(workspaceId, ...a),
        detachGroupGrant: (groupId: string) => P.detachGroupFromWorkspace(workspaceId, groupId),
        /** Per-resource (agent/skill/secret) grants to a member or a group. */
        resourceGrants: {
          list: () => P.listWorkspaceResourceGrants(workspaceId),
          create: (input: Parameters<typeof P.createWorkspaceResourceGrant>[1]) =>
            P.createWorkspaceResourceGrant(workspaceId, input),
          remove: (grantId: string) => P.deleteWorkspaceResourceGrant(workspaceId, grantId),
        },
      },

      connectors: {
        list: () => P.listConnectors(workspaceId),
        config: (...a: DropFirst<Parameters<typeof P.getConnectorConfig>>) =>
          P.getConnectorConfig(workspaceId, ...a),
        create: (...a: DropFirst<Parameters<typeof P.createConnector>>) =>
          P.createConnector(workspaceId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.deleteConnector>>) =>
          P.deleteConnector(workspaceId, ...a),
        sync: () => P.syncConnectors(workspaceId),
        auth: {
          discover: (...a: DropFirst<Parameters<typeof P.discoverConnectorAuth>>) =>
            P.discoverConnectorAuth(workspaceId, ...a),
        },
        setName: (...a: DropFirst<Parameters<typeof P.setConnectorName>>) =>
          P.setConnectorName(workspaceId, ...a),
        setCredentialMode: (...a: DropFirst<Parameters<typeof P.setConnectorCredentialMode>>) =>
          P.setConnectorCredentialMode(workspaceId, ...a),
        setCredential: (...a: DropFirst<Parameters<typeof P.setConnectorCredential>>) =>
          P.setConnectorCredential(workspaceId, ...a),
        setSensitive: (...a: DropFirst<Parameters<typeof P.setConnectorSensitive>>) =>
          P.setConnectorSensitive(workspaceId, ...a),
        profiles: {
          list: () => P.listConnectionProfiles(workspaceId),
          listAll: () => P.listAllConnectionProfiles(workspaceId),
          reconcile: (...a: DropFirst<Parameters<typeof P.reconcileConnectionProfile>>) =>
            P.reconcileConnectionProfile(workspaceId, ...a),
          reconcileMember: (
            ...a: DropFirst<Parameters<typeof P.reconcileMemberConnectionProfile>>
          ) => P.reconcileMemberConnectionProfile(workspaceId, ...a),
          updateCredential: (
            ...a: DropFirst<Parameters<typeof P.updateConnectionProfileCredential>>
          ) => P.updateConnectionProfileCredential(workspaceId, ...a),
          revoke: (...a: DropFirst<Parameters<typeof P.revokeConnectionProfile>>) =>
            P.revokeConnectionProfile(workspaceId, ...a),
          activate: (...a: DropFirst<Parameters<typeof P.activateConnectionProfile>>) =>
            P.activateConnectionProfile(workspaceId, ...a),
          setDefault: (...a: DropFirst<Parameters<typeof P.setDefaultConnectionProfile>>) =>
            P.setDefaultConnectionProfile(workspaceId, ...a),
          pipedreamConnect: (
            ...a: DropFirst<Parameters<typeof P.pipedreamConnectConnectionProfile>>
          ) => P.pipedreamConnectConnectionProfile(workspaceId, ...a),
          pipedreamFinalize: (
            ...a: DropFirst<Parameters<typeof P.pipedreamFinalizeConnectionProfile>>
          ) => P.pipedreamFinalizeConnectionProfile(workspaceId, ...a),
        },
        policies: {
          get: (...a: DropFirst<Parameters<typeof P.getConnectorPolicies>>) =>
            P.getConnectorPolicies(workspaceId, ...a),
          set: (...a: DropFirst<Parameters<typeof P.setConnectorPolicies>>) =>
            P.setConnectorPolicies(workspaceId, ...a),
        },
        /** Easy-connect (Pipedream): app catalog + connect/finalize handshake. */
        pipedream: {
          listApps: (...a: DropFirst<Parameters<typeof P.listPipedreamApps>>) =>
            P.listPipedreamApps(workspaceId, ...a),
          connect: (...a: DropFirst<Parameters<typeof P.pipedreamConnect>>) =>
            P.pipedreamConnect(workspaceId, ...a),
          finalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalize>>) =>
            P.pipedreamFinalize(workspaceId, ...a),
        },
        /** Direct integrations.sh catalogue and normalized domain surfaces. */
        discover: {
          list: (...a: DropFirst<Parameters<typeof P.listDiscoverIntegrations>>) =>
            P.listDiscoverIntegrations(workspaceId, ...a),
          detail: (...a: DropFirst<Parameters<typeof P.getDiscoverIntegration>>) =>
            P.getDiscoverIntegration(workspaceId, ...a),
        },
      },

      policies: {
        list: () => P.listWorkspacePolicies(workspaceId),
        set: (...a: DropFirst<Parameters<typeof P.setWorkspacePolicies>>) =>
          P.setWorkspacePolicies(workspaceId, ...a),
      },

      triggers: {
        list: () => P.listWorkspaceTriggers(workspaceId),
        create: (...a: DropFirst<Parameters<typeof P.createWorkspaceTrigger>>) =>
          P.createWorkspaceTrigger(workspaceId, ...a),
        update: (...a: DropFirst<Parameters<typeof P.updateWorkspaceTrigger>>) =>
          P.updateWorkspaceTrigger(workspaceId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.deleteWorkspaceTrigger>>) =>
          P.deleteWorkspaceTrigger(workspaceId, ...a),
        fire: (...a: DropFirst<Parameters<typeof P.fireWorkspaceTrigger>>) =>
          P.fireWorkspaceTrigger(workspaceId, ...a),
        setActivation: (...a: DropFirst<Parameters<typeof P.setWorkspaceTriggersActivation>>) =>
          P.setWorkspaceTriggersActivation(workspaceId, ...a),
      },

      files: {
        list: (options?: Parameters<typeof P.listWorkspaceFiles>[1]) =>
          P.listWorkspaceFiles(workspaceId, options),
        read: (path: string, ref?: string) => P.readWorkspaceFile(workspaceId, path, ref),
        search: (...a: DropFirst<Parameters<typeof P.searchWorkspaceFiles>>) =>
          P.searchWorkspaceFiles(workspaceId, ...a),
        archive: (...a: DropFirst<Parameters<typeof P.fetchWorkspaceArchive>>) =>
          P.fetchWorkspaceArchive(workspaceId, ...a),
        history: (...a: DropFirst<Parameters<typeof P.getWorkspaceFileHistory>>) =>
          P.getWorkspaceFileHistory(workspaceId, ...a),
      },

      git: {
        commits: () => P.listWorkspaceCommits(workspaceId),
        commit: (sha: string) => P.getWorkspaceCommit(workspaceId, sha),
        commitDiff: (sha: string) => P.getWorkspaceCommitDiff(workspaceId, sha),
        branches: () => P.listWorkspaceBranches(workspaceId),
        versionDiff: (...a: DropFirst<Parameters<typeof P.getVersionDiff>>) =>
          P.getVersionDiff(workspaceId, ...a),
        /** Invite a GitHub user as a collaborator on a Kortix-managed repo. */
        inviteCollaborator: (...a: DropFirst<Parameters<typeof P.inviteRepoCollaborator>>) =>
          P.inviteRepoCollaborator(workspaceId, ...a),
      },

      changeRequests: {
        list: () => P.listChangeRequests(workspaceId),
        get: (crId: string) => P.getChangeRequest(workspaceId, crId),
        diff: (crId: string) => P.getChangeRequestDiff(workspaceId, crId),
        mergePreview: (crId: string) => P.getChangeRequestMergePreview(workspaceId, crId),
        open: (...a: DropFirst<Parameters<typeof P.openChangeRequest>>) =>
          P.openChangeRequest(workspaceId, ...a),
        merge: (...a: DropFirst<Parameters<typeof P.mergeChangeRequest>>) =>
          P.mergeChangeRequest(workspaceId, ...a),
        close: (...a: DropFirst<Parameters<typeof P.closeChangeRequest>>) =>
          P.closeChangeRequest(workspaceId, ...a),
        reopen: (...a: DropFirst<Parameters<typeof P.reopenChangeRequest>>) =>
          P.reopenChangeRequest(workspaceId, ...a),
        /** Request changes on a CR (Review Center) — records feedback + optionally delivers it back to the originating session. */
        requestChanges: (...a: DropFirst<Parameters<typeof P.requestChangesOnChangeRequest>>) =>
          P.requestChangesOnChangeRequest(workspaceId, ...a),
      },

      sessions: {
        list: (options?: Parameters<typeof P.listWorkspaceSessions>[1]) =>
          P.listWorkspaceSessions(workspaceId, options),
        create: (input?: Parameters<typeof P.createWorkspaceSession>[1]) =>
          P.createWorkspaceSession(workspaceId, input),
        ensureWarm: () => P.ensureWarmWorkspaceSession(workspaceId),
        claimWarm: (input: Parameters<typeof P.claimWarmWorkspaceSession>[1]) =>
          P.claimWarmWorkspaceSession(workspaceId, input),
      },

      /** Review Center — the per-workspace human-in-the-loop inbox (change requests, tool approvals, agent outputs/decisions). */
      review: {
        list: (params?: Parameters<typeof P.listReviewItems>[1]) =>
          P.listReviewItems(workspaceId, params),
        get: (reviewItemId: string) => P.getReviewItem(workspaceId, reviewItemId),
        submit: (input: Parameters<typeof P.submitReviewItem>[1]) =>
          P.submitReviewItem(workspaceId, input),
        act: (...a: DropFirst<Parameters<typeof P.actReviewItem>>) =>
          P.actReviewItem(workspaceId, ...a),
        bulkAct: (input: Parameters<typeof P.bulkActReviewItems>[1]) =>
          P.bulkActReviewItems(workspaceId, input),
      },

      /** The manager inbox of executor-gated actions awaiting approve/deny (APPROVE / ASK / BLOCK). */
      approvals: {
        list: (options?: Parameters<typeof P.listPendingApprovals>[1]) =>
          P.listPendingApprovals(workspaceId, options),
        resolve: (...a: DropFirst<Parameters<typeof P.resolveApproval>>) =>
          P.resolveApproval(workspaceId, ...a),
        sessionsNeedingInput: (options?: Parameters<typeof P.listSessionsNeedingInput>[1]) =>
          P.listSessionsNeedingInput(workspaceId, options),
      },

      /** Gateway observability — LLM request logs, cost/latency rollups, budgets, gateway API keys. */
      gateway: {
        logs: (opts?: Parameters<typeof P.listGatewayLogs>[1]) =>
          P.listGatewayLogs(workspaceId, opts),
        log: (logId: string) => P.getGatewayLog(workspaceId, logId),
        overview: (days?: number) => P.getGatewayOverview(workspaceId, days),
        series: (days?: number) => P.getGatewaySeries(workspaceId, days),
        breakdown: (days?: number) => P.getGatewayBreakdown(workspaceId, days),
        sessions: (days?: number) => P.getGatewaySessions(workspaceId, days),
        errors: (days?: number) => P.getGatewayErrors(workspaceId, days),
        budgets: () => P.getGatewayBudgets(workspaceId),
        setBudget: (input: Parameters<typeof P.setGatewayBudget>[1]) =>
          P.setGatewayBudget(workspaceId, input),
        deleteBudget: (budgetId: string) => P.deleteGatewayBudget(workspaceId, budgetId),
        keys: () => P.getGatewayKeys(workspaceId),
        createKey: (name: string) => P.createGatewayKey(workspaceId, name),
        revokeKey: (keyId: string) => P.revokeGatewayKey(workspaceId, keyId),
        routing: {
          get: () => P.getGatewayRoutingPolicy(workspaceId),
          set: (policy: Parameters<typeof P.setGatewayRoutingPolicy>[1]) =>
            P.setGatewayRoutingPolicy(workspaceId, policy),
          reset: () => P.resetGatewayRoutingPolicy(workspaceId),
          preview: (input: Parameters<typeof P.previewGatewayRoute>[1]) =>
            P.previewGatewayRoute(workspaceId, input),
        },
        /** Run one prompt against up to 6 models side by side (a model-comparison playground). */
        playground: (prompt: string, models: string[], system?: string) =>
          P.runGatewayPlayground(workspaceId, prompt, models, system),
      },

      /** Slack + email + Meet channel integrations. */
      channels: {
        slack: {
          installation: () => P.getSlackInstallation(workspaceId),
          connect: (input: Parameters<typeof P.connectSlack>[1]) =>
            P.connectSlack(workspaceId, input),
          mode: () => P.getSlackMode(workspaceId),
          manifest: () => P.getSlackManifest(workspaceId),
          disconnect: () => P.disconnectSlack(workspaceId),
          /** Download a Slack-hosted file through the server-side proxy (bot token stays server-side). */
          getFile: (url: string) => P.getSlackChannelFile(workspaceId, url),
          /** Upload a file to Slack through the server-side 3-step external-upload proxy. */
          uploadFile: (input: Parameters<typeof P.uploadSlackChannelFile>[1]) =>
            P.uploadSlackChannelFile(workspaceId, input),
        },
        email: {
          installation: (connectorSlug?: string | null) =>
            P.getEmailInstallation(workspaceId, connectorSlug),
          mode: () => P.getEmailMode(workspaceId),
          connect: (input: Parameters<typeof P.connectEmail>[1]) =>
            P.connectEmail(workspaceId, input),
          disconnect: (connectorSlug?: string | null) =>
            P.disconnectEmail(workspaceId, connectorSlug),
          updatePolicy: (...a: DropFirst<Parameters<typeof P.updateEmailPolicy>>) =>
            P.updateEmailPolicy(workspaceId, ...a),
        },
        voice: {
          setBotName: (name: string) => P.setMeetBotName(workspaceId, name),
        },
      },

      /** Toggle an experimental feature (Customize → Settings → Experimental). Pass `enabled: null` to clear the override. */
      updateExperimentalFeature: (
        ...a: DropFirst<Parameters<typeof P.updateExperimentalFeature>>
      ) => P.updateExperimentalFeature(workspaceId, ...a),

      /** Default model preferences (account/agent/workspace scope, gateway-resolved). */
      modelDefaults: {
        get: () => P.getModelDefaults(workspaceId),
        set: (input: Parameters<typeof P.setModelDefault>[1]) =>
          P.setModelDefault(workspaceId, input),
        clear: (params: Parameters<typeof P.clearModelDefault>[1]) =>
          P.clearModelDefault(workspaceId, params),
      },

      /** Set the agent used when a new workspace session does not name one explicitly. */
      setDefaultAgent: (agentName: string) => P.updateWorkspaceDefaultAgent(workspaceId, agentName),

      /** Sandbox templates + snapshot builds — Dockerfile/image/warm-pool config, beyond `sandboxHealth`/`sandboxTemplates`. */
      sandbox: {
        list: () => P.listWorkspaceSandboxes(workspaceId),
        snapshots: () => P.listWorkspaceSnapshots(workspaceId),
        rebuildSnapshot: (slug?: string) => P.rebuildWorkspaceSnapshot(workspaceId, slug),
        fixWithAgent: () => P.fixSandboxWithAgent(workspaceId),
        createTemplate: (input: Parameters<typeof P.createSandboxTemplate>[1]) =>
          P.createSandboxTemplate(workspaceId, input),
        updateTemplate: (...a: DropFirst<Parameters<typeof P.updateSandboxTemplate>>) =>
          P.updateSandboxTemplate(workspaceId, ...a),
        removeTemplate: (templateId: string) => P.deleteSandboxTemplate(workspaceId, templateId),
        buildTemplate: (templateId: string) => P.buildSandboxTemplate(workspaceId, templateId),
        /** Pin/clear the per-workspace sandbox provider (null = follow the platform default). */
        setProvider: (provider: Parameters<typeof P.updateWorkspaceSandboxProvider>[1]) =>
          P.updateWorkspaceSandboxProvider(workspaceId, provider),
      },

      /** Bind specific secrets + connectors to an agent (the inheritance pyramid's declaration step). */
      setAgentScope: (...a: DropFirst<Parameters<typeof P.setAgentScope>>) =>
        P.setAgentScope(workspaceId, ...a),

      session: (sessionId: string) => session(workspaceId, sessionId),
    };
  }

  /** Id-bound handle for a single session: lifecycle (REST) + runtime (opencode). */
  function session(workspaceId: string, sessionId: string) {
    // Opinionated-action state, scoped to THIS handle. The opencode runtime is
    // keyed by the OpenCode session id (resolved server-side at /start), NOT the
    // Kortix `sessionId` — they differ. We resolve+cache it once (including the
    // resolved runtime URL + sandbox id), and remember a chosen model so `send`
    // carries it. Every runtime-scoped operation below reads ONLY this cached
    // record — never the module-global "currently active" runtime — so two
    // session handles pointed at two different sandboxes never cross wires.
    let _ready: SessionRuntimeEntry | null = null;
    let _model: SessionModel | undefined;
    let _agent: string | undefined;

    /**
     * Adopt an already-resolved runtime for THIS (workspaceId, sessionId) from
     * the shared session-runtime registry, if this handle hasn't resolved one
     * itself yet. This is what lets a brand-new `kortix.session(pid, sid)`
     * handle — e.g. a one-off poll tick, or a handle created independently of
     * the one that actually drove `/start` — use a session another handle (or
     * the React `useSession` hook) already brought up, instead of throwing
     * `SessionNotReadyError` or re-provisioning.
     */
    function tryResolveReady(): SessionRuntimeEntry | null {
      if (_ready) return _ready;
      const cached = getSessionRuntime(workspaceId, sessionId);
      if (cached) _ready = cached;
      return _ready;
    }

    /**
     * Make this session's runtime reachable and return its OpenCode session id
     * (plus this handle's own resolved runtime URL + sandbox id). Idempotent:
     * adopts the registry entry if another handle already resolved this
     * session; otherwise `start` provisions/resumes the sandbox (long-poll
     * until ready) — which itself populates the registry on success — and we
     * cache the resolved runtime for THIS handle. Also points the app's shared
     * "current runtime" store there, for React hosts that still read it.
     */
    async function ensureReady(opts?: { readyTimeoutMs?: number }): Promise<SessionRuntimeEntry> {
      const cached = tryResolveReady();
      if (cached) return cached;
      const readyTimeoutMs = opts?.readyTimeoutMs ?? 180_000;

      // Dedup concurrent starts for this (workspaceId, sessionId) — see
      // `inFlightSessionStarts`'s doc comment. If another call (this handle or
      // a different one) already kicked off `/start`, ride its result instead
      // of issuing a second POST.
      const key = `${workspaceId}\n${sessionId}`;
      const inFlight = inFlightSessionStarts.get(key);
      if (inFlight) {
        _ready = await inFlight;
        return _ready;
      }

      const startPromise = (async (): Promise<SessionRuntimeEntry> => {
        // Poll /start (each call long-polls up to 30s) until the runtime is
        // ready. `/start` returns `retriable: true` while the sandbox is still
        // provisioning/starting — a cold start can outlast a single long-poll —
        // so keep polling until it's ready, hits a terminal stage, or the
        // deadline. A single check would spuriously throw RUNTIME_UNAVAILABLE
        // on a slow boot, which is exactly what a backend waiting to send the
        // first turn must not do.
        const deadline = Date.now() + readyTimeoutMs;
        // Cap each server long-poll (and the inter-poll pause) to the time left
        // so the total honors readyTimeoutMs — a fixed 30s wait would overshoot
        // the deadline by up to ~30s on the final iteration.
        const remainingMs = () => Math.max(0, deadline - Date.now());
        let started = await P.startWorkspaceSession(
          workspaceId,
          sessionId,
          Math.min(30_000, remainingMs()),
        );
        // Keep polling while the runtime is still coming up. A `null` result is
        // a TRANSIENT tick, not a terminal state: startWorkspaceSession returns
        // null for a 5xx/408/429/network blip AND the create→start 404 race
        // (row not yet visible on the read path) — the exact cases a backend
        // hits calling ensureReady() right after create(). Only a resolved
        // provisioning/starting+retriable result or the deadline keeps/ends the
        // loop; ready/failed/stopped fall through to the guard below.
        while (
          Date.now() < deadline &&
          (started == null ||
            ((started.stage === 'provisioning' || started.stage === 'starting') &&
              started.retriable))
        ) {
          await new Promise((r) => setTimeout(r, Math.min(1_000, remainingMs())));
          started = await P.startWorkspaceSession(
            workspaceId,
            sessionId,
            Math.min(30_000, remainingMs()),
          );
        }
        if (
          !started ||
          started.stage !== 'ready' ||
          !started.sandbox ||
          !started.opencode_session_id
        ) {
          throw new ApiError(`Session runtime not ready (stage: ${started?.stage ?? 'unknown'})`, {
            code: 'RUNTIME_UNAVAILABLE',
          });
        }
        const externalId = (started.sandbox as { external_id?: string | null }).external_id;
        if (!externalId) {
          throw new ApiError(
            'Session sandbox has no external_id — cannot resolve its runtime URL',
            {
            code: 'RUNTIME_UNAVAILABLE',
            },
          );
        }
        const runtimeUrl = getSandboxUrlForExternalId(externalId);
        // Point the app's shared runtime store at this session too, so React
        // hosts (which read the global current-runtime) keep working — but this
        // handle's own operations never read it back, only `_ready` below.
        setCurrentRuntime(runtimeUrl, externalId);
        return {
          opencodeSessionId: started.opencode_session_id,
          runtimeUrl,
          sandboxId: externalId,
        };
      })();

      inFlightSessionStarts.set(key, startPromise);
      try {
        _ready = await startPromise;
        return _ready;
      } finally {
        if (inFlightSessionStarts.get(key) === startPromise) {
          inFlightSessionStarts.delete(key);
        }
      }
    }

    /** Throw `SessionNotReadyError` if neither this handle nor the registry has resolved a runtime yet. */
    function requireReady(action: string): SessionRuntimeEntry {
      const ready = tryResolveReady();
      if (!ready) throw new SessionNotReadyError(action);
      return ready;
    }

    /** Clear this handle's cached runtime + the shared registry entry (restart/delete). */
    function forgetReady(): void {
      _ready = null;
      clearSessionRuntime(workspaceId, sessionId);
    }

    return {
      // ── lifecycle (Kortix REST) ──────────────────────────────────────────
      get: (opts?: { showErrors?: boolean }) => P.getWorkspaceSession(workspaceId, sessionId, opts),
      update: (input: Parameters<typeof P.updateWorkspaceSession>[2]) =>
        P.updateWorkspaceSession(workspaceId, sessionId, input),
      delete: () => {
        // A deleted session's sandbox is gone — never let a later handle for
        // this (workspaceId, sessionId) resolve a runtime that no longer exists.
        forgetReady();
        return P.deleteWorkspaceSession(workspaceId, sessionId);
      },
      start: (...a: DropFirst2<Parameters<typeof P.startWorkspaceSession>>) =>
        P.startWorkspaceSession(workspaceId, sessionId, ...a),
      restart: () => {
        // Restart preserves the established sandbox identity, but readiness
        // and the proxy connection must still be resolved again after reboot.
        forgetReady();
        return P.restartWorkspaceSession(workspaceId, sessionId);
      },
      stop: () => {
        forgetReady();
        return P.stopWorkspaceSession(workspaceId, sessionId);
      },
      setSharing: (intent: Parameters<typeof P.setWorkspaceSessionSharing>[2]) =>
        P.setWorkspaceSessionSharing(workspaceId, sessionId, intent),
      previews: () => P.getSessionPreviewCandidates(workspaceId, sessionId),
      commit: (input?: Parameters<typeof P.commitSessionChanges>[2]) =>
        P.commitSessionChanges(workspaceId, sessionId, input),
      publicShares: {
        list: () => P.listSessionPublicShares(workspaceId, sessionId),
        create: (...a: DropFirst2<Parameters<typeof P.createSessionPublicShare>>) =>
          P.createSessionPublicShare(workspaceId, sessionId, ...a),
        revoke: (...a: DropFirst2<Parameters<typeof P.revokeSessionPublicShare>>) =>
          P.revokeSessionPublicShare(workspaceId, sessionId, ...a),
      },
      /** Per-session audit trail of executor-gated agent actions. */
      audit: (limit?: number, options?: { showErrors?: boolean }) =>
        P.getSessionAudit(workspaceId, sessionId, limit, options),
      /** Compact server-side transcript read (text + tool calls, no tool inputs/outputs) — callable with workspace-scoped session tokens. */
      transcript: (options?: Parameters<typeof P.getSessionTranscript>[2]) =>
        P.getSessionTranscript(workspaceId, sessionId, options),
      /** This session's live voice-call transcript (spoken turns + ask_kortix/run_command calls). */
      voiceTranscript: (options?: Parameters<typeof P.getVoiceTranscript>[2]) =>
        P.getVoiceTranscript(workspaceId, sessionId, options),

      /**
       * Resolve THIS handle's own runtime (idempotent): provisions/resumes the
       * sandbox (long-poll until ready) and caches the resolved OpenCode session
       * id + runtime URL + sandbox id for every other call on this handle. Call
       * this (or `send`/`abort`, which call it internally) before `.runtime`,
       * `.health()`, `.previewUrl()`, or `.proxyUrl()` — those throw
       * `SessionNotReadyError` instead of falling back to whatever sandbox
       * happens to be globally active.
       */
      ensureReady,

      // ── runtime health + preview (the session owns its runtime) ──────────
      /**
       * Liveness/readiness of THIS session's runtime (`GET /kortix/health`).
       * Unlike `.previewUrl()`/`.proxyUrl()`/`.runtime`, this never throws
       * `SessionNotReadyError` — a health poller (e.g. a header dot ticking
       * every 15s on a fresh inline handle) needs to be callable BEFORE the
       * session has ever resolved a runtime. It degrades to the same graceful
       * `{ status: 0, ok: false }` shape `getSessionHealth` already returns for
       * "no URL yet", instead of forcing every caller to guard with `ensureReady()`.
       */
      health: (init?: RequestInit) => getSessionHealth(tryResolveReady()?.runtimeUrl ?? null, init),
      /** Proxy/preview URL for a port THIS session's runtime exposes. */
      previewUrl: (port: number, path = '/') =>
        rewriteLocalhostUrl(
          port,
          path,
          resolvePreviewOptsForSandbox(requireReady('previewUrl').sandboxId),
        ),
      /** Rewrite a localhost URL the agent printed into a reachable proxy URL. */
      proxyUrl: (url?: string) =>
        proxyLocalhostUrl(url, resolvePreviewOptsForSandbox(requireReady('proxyUrl').sandboxId)),

      // ── agent actions (opinionated wrappers over the runtime) ────────────
      // These do the right thing end-to-end for scripts/non-React hosts: ensure
      // the runtime is up, resolve the OpenCode session id, and act through a
      // client bound to THIS handle's own runtime URL (never the module-global
      // "active" one, so parallel handles on different sandboxes never cross
      // wires). React hosts use `@kortix/sdk/react` hooks instead, which bind to
      // the same resolved id reactively (see the white-label reference app).
      /** Pick the model `send` will use for subsequent prompts (until changed). */
      setModel: (model: SessionModel | undefined) => {
        _model = model;
      },
      /**
       * PERSIST a new model for this session server-side, re-pointing the
       * running sandbox. Distinct from `setModel`, which only chooses what the
       * NEXT local `send` asks for and never leaves this handle.
       *
       * Restarting the runtime is how the change takes effect, so an in-flight
       * turn ends. `applied_live` reports whether a running session took it now
       * or whether it applies at next start.
       */
      changeModel: (model: string) => P.setWorkspaceSessionModel(workspaceId, sessionId, model),
      /** Pick the agent `send` will use for subsequent prompts (until changed). */
      setAgent: (agent: string | undefined) => {
        _agent = agent;
      },
      /**
       * Provision/resume if needed, then send a text prompt to the agent. A
       * per-call `{ model, agent }` overrides the sticky setModel/setAgent
       * choices for this message only.
       */
      send: async (text: string, opts?: { model?: SessionModel; agent?: string }) => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        const model = opts?.model ?? _model;
        const agent = opts?.agent ?? _agent;
        return getClientForUrl(runtimeUrl).session.prompt({
          sessionID: opencodeSessionId,
          parts: [{ type: 'text', text }],
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        });
      },
      /** Abort the agent's current run in this session. */
      abort: async () => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.abort({
          sessionID: opencodeSessionId,
        });
      },
      /**
       * Stage a reversible rollback at one user message on this same canonical
       * OpenCode session. The next prompt commits the new path.
       */
      rewind: async (messageId: string) => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.revert({
          sessionID: opencodeSessionId,
          messageID: messageId,
        });
      },
      /** Restore the path removed by `rewind()` before another prompt commits it. */
      restoreRewind: async () => {
        const { opencodeSessionId, runtimeUrl } = await ensureReady();
        return getClientForUrl(runtimeUrl).session.unrevert({
          sessionID: opencodeSessionId,
        });
      },
      /**
       * Live SSE stream of THIS session's runtime events (message/part
       * updates, session status, permissions/questions, lsp diagnostics, …).
       * A thin facade over the framework-free `openEventStream` primitive
       * (`@kortix/sdk`'s `openEventStream`, also used verbatim by
       * `@kortix/sdk/react`'s `useOpenCodeEventStream`): resolves THIS
       * handle's own runtime first (`ensureReady()`), then connects a client
       * bound to that runtime URL — never the module-global "active" one, so
       * two session handles on two different sandboxes never cross wires.
       * Framework-free — safe to call from a server-side "Kortix as a
       * Backend" wrapper (Node/Bun), a worker, a CLI, or any non-React host.
       *
       * Handles connect/reconnect/backoff, a 15s heartbeat watchdog, and
       * event coalescing internally. Call `handle.close()` to stop.
       *
       *   const handle = await session.stream({ onEvent: (e) => console.log(e) });
       *   // later
       *   handle.close();
       */
      stream: async (opts: {
        onEvent: (event: OpenCodeEvent) => void;
        onGapRehydrate?: (gapMs: number) => void;
        signal?: AbortSignal;
      }): Promise<EventStreamHandle> => {
        const { runtimeUrl } = await ensureReady();
        return openEventStream({
          client: getClientForUrl(runtimeUrl),
          onEvent: opts.onEvent,
          onGapRehydrate: opts.onGapRehydrate,
          signal: opts.signal,
        });
      },

      // ── runtime (opencode v2, THIS session's own sandbox) ────────────────
      // The typed opencode client, reached ONLY through the SDK. The host never
      // imports `@opencode-ai/sdk`. Opinionated wrappers (prompt/abort/setModel
      // with server-owned side-effects) layer on top of this as they land.
      get runtime(): OpencodeClient {
        return getClientForUrl(requireReady('runtime').runtimeUrl);
      },

      /**
       * Workspace file operations (daemon `/file` + `/find`) bound to THIS
       * session's own resolved runtime — never the module-global "active"
       * sandbox the top-level `@kortix/sdk` `files` export follows. Fixes a
       * cross-session bleed: a host juggling multiple open sessions (e.g. a
       * server wrapping several concurrent agent sessions) that called the
       * global `files.list()` while a DIFFERENT session was "active" would
       * silently read/write the wrong sandbox. Each call here auto-provisions
       * via `ensureReady()` (same as `send`/`abort`/`stream`), then runs
       * against this handle's own runtime URL. Same 12-op surface as the
       * global `files` namespace, built from the same parameterized core
       * (`@kortix/sdk/files`'s exports all take an optional trailing
       * `baseUrl` — this just always supplies THIS session's).
       */
      files: {
        list: async (dirPath: string) => F.listFiles(dirPath, (await ensureReady()).runtimeUrl),
        read: async (filePath: string) => F.readFile(filePath, (await ensureReady()).runtimeUrl),
        readBlob: async (filePath: string) =>
          F.readBlob(filePath, (await ensureReady()).runtimeUrl),
        status: async () => F.getFileStatus((await ensureReady()).runtimeUrl),
        findFiles: async (
          query: string,
          options?: { type?: 'file' | 'directory'; limit?: number },
        ) => F.findFiles(query, options, (await ensureReady()).runtimeUrl),
        findText: async (pattern: string) => F.findText(pattern, (await ensureReady()).runtimeUrl),
        upload: async (file: File | Blob, targetPath?: string, filename?: string) =>
          F.uploadFile(file, targetPath, filename, (await ensureReady()).runtimeUrl),
        create: async (filePath: string) =>
          F.createFile(filePath, (await ensureReady()).runtimeUrl),
        copy: async (sourcePath: string, destPath: string) =>
          F.copyFile(sourcePath, destPath, (await ensureReady()).runtimeUrl),
        remove: async (filePath: string) =>
          F.deleteFile(filePath, (await ensureReady()).runtimeUrl),
        mkdir: async (dirPath: string) => F.mkdir(dirPath, (await ensureReady()).runtimeUrl),
        rename: async (from: string, to: string) =>
          F.renameFile(from, to, (await ensureReady()).runtimeUrl),
      },
    };
  }

  return {
    /** The platform config in effect (for diagnostics). */
    config,
    accounts,
    /** Account-invite lifecycle reached by invite token alone (accept/decline/describe). */
    accountInvites,
    workspaces,
    workspace,
    /** @deprecated Use `workspaces`. */
    projects,
    /** @deprecated Use `workspace(workspaceId)`. */
    project: workspace,
    session,
    /** GitHub App installation + repository linking (account-scoped). */
    github,
    /** Billing read surface — credits/subscription/tier/transactions (not workspace-scoped). */
    billing,
    /** Public share links for a sandbox port (`/v1/p/share`, sandbox-scoped). */
    sandboxShares,
    /** Speech-to-text transcription (`/transcription` — not workspace-scoped). */
    transcribe: P.transcribeAudio,
    /** Deployment-wide Pipedream/easy-connect availability flag (not workspace-scoped). */
    connectStatus,
    /** Public marketplace catalog browse + sources (`/v1/marketplace/*`, not workspace-scoped). */
    marketplace,
    /** The pasted-API-key UX check — `GET /accounts/me`, never throws. */
    validateToken: P.validateToken,
    /** Escape hatch: the typed opencode client for the active sandbox. */
    runtime,
  };
}

export type Kortix = ReturnType<typeof createKortix>;
/** The id-bound workspace handle returned by `kortix.workspace(id)`. */
export type WorkspaceHandle = ReturnType<Kortix['workspace']>;
/** @deprecated Use `WorkspaceHandle`. */
export type ProjectHandle = WorkspaceHandle;
/** The id-bound session handle returned by `kortix.session(pid, sid)`. */
export type SessionHandle = ReturnType<Kortix['session']>;

// ── tiny tuple helpers: bind the leading id arg(s) without re-typing the rest ──
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
type DropFirst2<T extends unknown[]> = T extends [unknown, unknown, ...infer R] ? R : [];
