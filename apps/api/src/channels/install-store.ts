import { chatInstalls, workspaceSecrets } from '@kortix/db';
import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { config } from '../config';
import { decryptWorkspaceSecret, encryptWorkspaceSecret } from '../workspaces/secrets';
import { db } from '../shared/db';

export const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN';
export const SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET';
export const SLACK_TEAM_ID = 'SLACK_TEAM_ID';
export const SLACK_BOT_USER_ID = 'SLACK_BOT_USER_ID';
export const SLACK_TEAM_NAME = 'SLACK_TEAM_NAME';

export const TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';

export async function loadTelegramWebhookSecretForWorkspace(
  workspaceId: string,
): Promise<string | null> {
  return readSecret(workspaceId, TELEGRAM_WEBHOOK_SECRET);
}

export const AGENTMAIL_API_KEY = 'AGENTMAIL_API_KEY';
export const AGENTMAIL_INBOX_ID = 'AGENTMAIL_INBOX_ID';
export const AGENTMAIL_INBOX_EMAIL = 'AGENTMAIL_INBOX_EMAIL';
export const AGENTMAIL_INBOX_DISPLAY_NAME = 'AGENTMAIL_INBOX_DISPLAY_NAME';
export const AGENTMAIL_WEBHOOK_ID = 'AGENTMAIL_WEBHOOK_ID';
export const AGENTMAIL_WEBHOOK_SECRET = 'AGENTMAIL_WEBHOOK_SECRET';
export const AGENTMAIL_SENDER_POLICY = 'AGENTMAIL_SENDER_POLICY';

export const RECALL_API_KEY = 'RECALL_API_KEY';

export interface VoiceInstallSummary {
  /** Where the resolved Recall key came from — operator env or a workspace override. */
  source: 'workspace' | 'env';
}

/**
 * The Recall.ai API key for a workspace: a per-workspace override secret if set, else
 * the operator-wide config.RECALL_API_KEY. Server-side only — this key signs the
 * meet channel connector's `Authorization: Token` header and is never injected
 * into a sandbox.
 */
export async function loadVoiceTokenForWorkspace(workspaceId: string): Promise<string | null> {
  const override = await readSecret(workspaceId, RECALL_API_KEY);
  return override ?? (config.RECALL_API_KEY || null);
}

/** Cheap "is meet usable?" — a Recall key resolves (per-workspace override or env). */
export async function loadVoiceInstall(workspaceId: string): Promise<VoiceInstallSummary | null> {
  const override = await readSecret(workspaceId, RECALL_API_KEY).catch(() => null);
  if (override) return { source: 'workspace' };
  if (config.RECALL_API_KEY) return { source: 'env' };
  return null;
}

const SLACK_KEYS = [
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_NAME,
] as const;

const AGENTMAIL_KEYS = [
  AGENTMAIL_API_KEY,
  AGENTMAIL_INBOX_ID,
  AGENTMAIL_INBOX_EMAIL,
  AGENTMAIL_INBOX_DISPLAY_NAME,
  AGENTMAIL_WEBHOOK_ID,
  AGENTMAIL_WEBHOOK_SECRET,
  AGENTMAIL_SENDER_POLICY,
] as const;

export interface AgentMailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

export const DEFAULT_AGENTMAIL_SENDER_POLICY: AgentMailSenderPolicy = {
  mode: 'allow_all',
  allowedEmails: [],
  allowedDomains: [],
  allowedRegex: null,
};

export interface SlackInstallSummary {
  providerWorkspaceId: string;
  providerWorkspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export interface SlackInstallInput {
  workspaceId: string;
  botToken: string;
  signingSecret: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
}

export interface AgentMailInstallSummary {
  profileSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: AgentMailSenderPolicy;
  installedAt: string;
}

export interface AgentMailInstallInput {
  workspaceId: string;
  profileSlug?: string | null;
  apiKey?: string | null;
  inboxId: string;
  email: string;
  displayName?: string | null;
  webhookId?: string | null;
  webhookSecret?: string | null;
  senderPolicy?: AgentMailSenderPolicy | null;
}

function agentMailProfileSuffix(profileSlug?: string | null): string {
  const slug = (profileSlug || 'kortix_email').trim();
  if (!slug || slug === 'kortix_email') return '';
  return `_${slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

function agentMailKeys(profileSlug?: string | null) {
  const suffix = agentMailProfileSuffix(profileSlug);
  return {
    apiKey: `${AGENTMAIL_API_KEY}${suffix}`,
    inboxId: `${AGENTMAIL_INBOX_ID}${suffix}`,
    email: `${AGENTMAIL_INBOX_EMAIL}${suffix}`,
    displayName: `${AGENTMAIL_INBOX_DISPLAY_NAME}${suffix}`,
    webhookId: `${AGENTMAIL_WEBHOOK_ID}${suffix}`,
    webhookSecret: `${AGENTMAIL_WEBHOOK_SECRET}${suffix}`,
    senderPolicy: `${AGENTMAIL_SENDER_POLICY}${suffix}`,
  };
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter(Boolean),
    ),
  );
}

export function normalizeSenderPolicy(
  input?: Partial<AgentMailSenderPolicy> | null,
): AgentMailSenderPolicy {
  const allowedEmails = uniqueStrings(input?.allowedEmails);
  const allowedDomains = uniqueStrings(input?.allowedDomains).map((domain) =>
    domain.replace(/^@+/, ''),
  );
  const rawRegex = typeof input?.allowedRegex === 'string' ? input.allowedRegex.trim() : '';
  const restricted =
    input?.mode === 'restricted' ||
    allowedEmails.length > 0 ||
    allowedDomains.length > 0 ||
    rawRegex.length > 0;
  return {
    mode: restricted ? 'restricted' : 'allow_all',
    allowedEmails,
    allowedDomains,
    allowedRegex: rawRegex || null,
  };
}

function parseSenderPolicy(raw: string | null): AgentMailSenderPolicy {
  if (!raw) return DEFAULT_AGENTMAIL_SENDER_POLICY;
  try {
    return normalizeSenderPolicy(JSON.parse(raw) as Partial<AgentMailSenderPolicy>);
  } catch {
    return DEFAULT_AGENTMAIL_SENDER_POLICY;
  }
}

export async function saveSlackInstall(input: SlackInstallInput): Promise<SlackInstallSummary> {
  const { workspaceId } = input;
  await db
    .insert(chatInstalls)
    .values({
      platform: 'slack',
      providerWorkspaceId: input.teamId,
      workspaceId,
    })
    .onConflictDoNothing();
  await upsertSecret(workspaceId, SLACK_BOT_TOKEN, input.botToken);
  await upsertSecret(workspaceId, SLACK_SIGNING_SECRET, input.signingSecret);
  await upsertSecret(workspaceId, SLACK_TEAM_ID, input.teamId);
  await upsertSecret(workspaceId, SLACK_BOT_USER_ID, input.botUserId);
  await upsertSecret(workspaceId, SLACK_TEAM_NAME, input.teamName ?? '');
  return {
    providerWorkspaceId: input.teamId,
    providerWorkspaceName: input.teamName,
    botUserId: input.botUserId,
    installedAt: new Date().toISOString(),
  };
}

export async function deleteSlackInstall(workspaceId: string): Promise<void> {
  for (const name of SLACK_KEYS) {
    await db
      .delete(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, name)));
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, workspaceId)));
}

export async function saveAgentMailInstall(
  input: AgentMailInstallInput,
): Promise<AgentMailInstallSummary> {
  const { workspaceId } = input;
  const profileSlug = input.profileSlug || 'kortix_email';
  const keys = agentMailKeys(profileSlug);
  const previous = await loadAgentMailInstall(workspaceId, profileSlug);
  if (input.apiKey) await upsertSecret(workspaceId, keys.apiKey, input.apiKey);
  await upsertSecret(workspaceId, keys.inboxId, input.inboxId);
  await upsertSecret(workspaceId, keys.email, input.email);
  await upsertSecret(workspaceId, keys.displayName, input.displayName ?? '');
  await upsertSecret(workspaceId, keys.webhookId, input.webhookId ?? '');
  await upsertSecret(
    workspaceId,
    keys.senderPolicy,
    JSON.stringify(normalizeSenderPolicy(input.senderPolicy)),
  );
  if (input.webhookSecret) {
    await upsertSecret(workspaceId, keys.webhookSecret, input.webhookSecret);
  }
  if (previous?.inboxId) {
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.workspaceId, workspaceId),
          eq(chatInstalls.providerWorkspaceId, previous.inboxId),
        ),
      );
  }
  await db
    .delete(chatInstalls)
    .where(
      and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.providerWorkspaceId, input.inboxId)),
    );
  await db
    .insert(chatInstalls)
    .values({ platform: 'email', providerWorkspaceId: input.inboxId, workspaceId })
    .onConflictDoNothing({
      target: [chatInstalls.platform, chatInstalls.providerWorkspaceId, chatInstalls.workspaceId],
    });
  return {
    profileSlug,
    inboxId: input.inboxId,
    email: input.email,
    displayName: input.displayName ?? null,
    webhookId: input.webhookId ?? null,
    senderPolicy: normalizeSenderPolicy(input.senderPolicy),
    installedAt: new Date().toISOString(),
  };
}

export async function deleteAgentMailInstall(
  workspaceId: string,
  profileSlug?: string | null,
): Promise<void> {
  const keys = agentMailKeys(profileSlug);
  const install = await loadAgentMailInstall(workspaceId, profileSlug);
  for (const name of Object.values(keys)) {
    await db
      .delete(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, name)));
  }
  if (install?.inboxId) {
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.workspaceId, workspaceId),
          eq(chatInstalls.providerWorkspaceId, install.inboxId),
        ),
      );
  } else if (!profileSlug || profileSlug === 'kortix_email') {
    await db
      .delete(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.workspaceId, workspaceId)));
  }
}

function agentMailProfileSlugFromInboxSecret(name: string): string | null {
  if (!name.startsWith(AGENTMAIL_INBOX_ID)) return null;
  const suffix = name.slice(AGENTMAIL_INBOX_ID.length);
  if (!suffix) return 'kortix_email';
  return suffix.replace(/^_+/, '').toLowerCase() || null;
}

export async function listAgentMailInstalls(workspaceId: string): Promise<AgentMailInstallSummary[]> {
  const rows = await db
    .select({ name: workspaceSecrets.name, valueEnc: workspaceSecrets.valueEnc })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        like(workspaceSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(workspaceSecrets.ownerUserId),
      ),
    );

  const installs: AgentMailInstallSummary[] = [];
  for (const row of rows) {
    const profileSlug = agentMailProfileSlugFromInboxSecret(row.name);
    if (!profileSlug) continue;
    try {
      // Skip malformed or stale secret envelopes without poisoning the whole list.
      decryptWorkspaceSecret(workspaceId, row.valueEnc);
      const install = await loadAgentMailInstall(workspaceId, profileSlug);
      if (install) installs.push(install);
    } catch {}
  }
  return installs.sort((a, b) => a.profileSlug.localeCompare(b.profileSlug));
}

export async function updateAgentMailSenderPolicy(
  workspaceId: string,
  profileSlug: string | null | undefined,
  senderPolicy: AgentMailSenderPolicy,
): Promise<AgentMailInstallSummary | null> {
  const install = await loadAgentMailInstall(workspaceId, profileSlug);
  if (!install) return null;
  await upsertSecret(
    workspaceId,
    agentMailKeys(profileSlug).senderPolicy,
    JSON.stringify(normalizeSenderPolicy(senderPolicy)),
  );
  return loadAgentMailInstall(workspaceId, profileSlug);
}

export async function loadAgentMailInstall(
  workspaceId: string,
  profileSlug?: string | null,
): Promise<AgentMailInstallSummary | null> {
  const keys = agentMailKeys(profileSlug);
  const [inboxId, email, displayName, webhookId, senderPolicyRaw] = await Promise.all([
      readSecret(workspaceId, keys.inboxId),
      readSecret(workspaceId, keys.email),
      readSecret(workspaceId, keys.displayName),
      readSecret(workspaceId, keys.webhookId),
      readSecret(workspaceId, keys.senderPolicy),
    ]);
  if (!inboxId || !email) return null;
  const [row] = await db
    .select({ updatedAt: workspaceSecrets.updatedAt })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.name, keys.inboxId),
        isNull(workspaceSecrets.ownerUserId),
      ),
    )
    .limit(1);
  return {
    profileSlug: profileSlug || 'kortix_email',
    inboxId,
    email,
    displayName: displayName || null,
    webhookId: webhookId || null,
    senderPolicy: parseSenderPolicy(senderPolicyRaw),
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadAgentMailApiKeyForWorkspace(
  workspaceId: string,
  profileSlug?: string | null,
): Promise<string | null> {
  return readSecret(workspaceId, agentMailKeys(profileSlug).apiKey);
}

export async function loadAgentMailApiKeyForInbox(
  workspaceId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: workspaceSecrets.name, valueEnc: workspaceSecrets.valueEnc })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        like(workspaceSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(workspaceSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    let value: string | null = null;
    try {
      value = decryptWorkspaceSecret(workspaceId, row.valueEnc);
    } catch {
      continue;
    }
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return readSecret(workspaceId, `${AGENTMAIL_API_KEY}${suffix}`);
  }
  return null;
}

export async function loadAgentMailWebhookSecretForWorkspace(
  workspaceId: string,
): Promise<string | null> {
  return readSecret(workspaceId, AGENTMAIL_WEBHOOK_SECRET);
}

export async function loadAgentMailWebhookSecretForInbox(
  workspaceId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: workspaceSecrets.name, valueEnc: workspaceSecrets.valueEnc })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        like(workspaceSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(workspaceSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    let value: string | null = null;
    try {
      value = decryptWorkspaceSecret(workspaceId, row.valueEnc);
    } catch {
      continue;
    }
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return readSecret(workspaceId, `${AGENTMAIL_WEBHOOK_SECRET}${suffix}`);
  }
  return null;
}

export async function loadAgentMailSenderPolicyForInbox(
  workspaceId: string,
  inboxId: string,
): Promise<AgentMailSenderPolicy> {
  const rows = await db
    .select({ name: workspaceSecrets.name, valueEnc: workspaceSecrets.valueEnc })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        like(workspaceSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(workspaceSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    let value: string | null = null;
    try {
      value = decryptWorkspaceSecret(workspaceId, row.valueEnc);
    } catch {
      continue;
    }
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return parseSenderPolicy(await readSecret(workspaceId, `${AGENTMAIL_SENDER_POLICY}${suffix}`));
  }
  return DEFAULT_AGENTMAIL_SENDER_POLICY;
}

export interface SlackOauthInstallInput {
  workspaceId: string;
  providerWorkspaceId: string;
  botToken: string;
  botUserId: string;
  teamName: string | null;
}

// Universal Kortix Slack App install. Records this Kortix workspace's membership
// in the Slack workspace. Slack issues one token per app and Slack workspace.
// A reauthorization rotates that token, so every linked Kortix workspace receives
// the current token and provider metadata. The signing secret
// is the master Kortix one and stays server-side; it is never persisted here.
export async function saveSlackOauthInstall(
  input: SlackOauthInstallInput,
): Promise<SlackInstallSummary> {
  await db
    .insert(chatInstalls)
    .values({
      platform: 'slack',
      providerWorkspaceId: input.providerWorkspaceId,
      workspaceId: input.workspaceId,
    })
    .onConflictDoNothing();

  const workspaceIds = await listWorkspacesForProviderWorkspace(
    'slack',
    input.providerWorkspaceId,
  );
  if (!workspaceIds.includes(input.workspaceId)) workspaceIds.push(input.workspaceId);
  for (const workspaceId of workspaceIds) {
    await upsertSecret(workspaceId, SLACK_BOT_TOKEN, input.botToken);
    await upsertSecret(workspaceId, SLACK_TEAM_ID, input.providerWorkspaceId);
    await upsertSecret(workspaceId, SLACK_BOT_USER_ID, input.botUserId);
    await upsertSecret(workspaceId, SLACK_TEAM_NAME, input.teamName ?? '');
  }

  return {
    providerWorkspaceId: input.providerWorkspaceId,
    providerWorkspaceName: input.teamName,
    botUserId: input.botUserId,
    installedAt: new Date().toISOString(),
  };
}

export async function listWorkspacesForProviderWorkspace(
  platform: string,
  providerWorkspaceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, platform),
        eq(chatInstalls.providerWorkspaceId, providerWorkspaceId),
      ),
    );
  return rows.map((r) => r.workspaceId);
}

export async function loadSlackInstall(workspaceId: string): Promise<SlackInstallSummary | null> {
  // Read scope-agnostically: Slack credentials are stored with scope='connector'
  // (kept out of the sandbox env), which listWorkspaceSecrets deliberately drops —
  // so status must go through readSecret, matching the Teams install read path.
  const teamId = await readSecret(workspaceId, SLACK_TEAM_ID);
  if (!teamId) return null;
  const [row] = await db
    .select({ updatedAt: workspaceSecrets.updatedAt })
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, SLACK_TEAM_ID)))
    .limit(1);
  return {
    providerWorkspaceId: teamId,
    providerWorkspaceName: (await readSecret(workspaceId, SLACK_TEAM_NAME)) || null,
    botUserId: (await readSecret(workspaceId, SLACK_BOT_USER_ID)) || null,
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadSlackTokenForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, SLACK_BOT_TOKEN);
}

export async function loadSlackSigningSecretForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, SLACK_SIGNING_SECRET);
}

export async function loadSlackBotUserIdForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, SLACK_BOT_USER_ID);
}

export async function loadSlackTeamNameForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, SLACK_TEAM_NAME);
}

// ─── Microsoft Teams ──────────────────────────────────────────────────────

export const MS_TEAMS_TENANT_ID = 'MS_TEAMS_TENANT_ID';
export const MS_TEAMS_SERVICE_URL = 'MS_TEAMS_SERVICE_URL';
export const MS_TEAMS_TEAM_ID = 'MS_TEAMS_TEAM_ID';
export const MS_TEAMS_TEAM_NAME = 'MS_TEAMS_TEAM_NAME';
export const MS_TEAMS_BOT_ID = 'MS_TEAMS_BOT_ID';
export const MS_TEAMS_APP_ID = 'MS_TEAMS_APP_ID';
export const MS_TEAMS_APP_PASSWORD = 'MS_TEAMS_APP_PASSWORD';
export const MS_TEAMS_ORG_INSTALLED = 'MS_TEAMS_ORG_INSTALLED';
export const MS_TEAMS_CATALOG_APP_ID = 'MS_TEAMS_CATALOG_APP_ID';

const TEAMS_KEYS = [
  MS_TEAMS_TENANT_ID,
  MS_TEAMS_SERVICE_URL,
  MS_TEAMS_TEAM_ID,
  MS_TEAMS_TEAM_NAME,
  MS_TEAMS_BOT_ID,
  MS_TEAMS_APP_ID,
  MS_TEAMS_APP_PASSWORD,
  MS_TEAMS_ORG_INSTALLED,
  MS_TEAMS_CATALOG_APP_ID,
] as const;

export interface TeamsInstallSummary {
  tenantId: string;
  teamId: string | null;
  teamName: string | null;
  botId: string | null;
  serviceUrl: string | null;
  byo: boolean;
  orgInstalled: boolean;
  catalogAppId: string | null;
  installedAt: string;
}

export interface TeamsInstallInput {
  workspaceId: string;
  tenantId: string;
  teamId?: string | null;
  teamName?: string | null;
  botId?: string | null;
  serviceUrl?: string | null;
  appId?: string | null;
  appPassword?: string | null;
}

export interface TeamsBotCredentials {
  appId: string;
  appPassword: string;
}

export async function saveTeamsInstall(input: TeamsInstallInput): Promise<TeamsInstallSummary> {
  const { workspaceId, tenantId } = input;
  await db
    .insert(chatInstalls)
    .values({ platform: 'teams', providerWorkspaceId: tenantId, workspaceId })
    .onConflictDoNothing();

  await upsertSecret(workspaceId, MS_TEAMS_TENANT_ID, tenantId);
  if (input.teamId != null) await upsertSecret(workspaceId, MS_TEAMS_TEAM_ID, input.teamId);
  if (input.teamName != null) await upsertSecret(workspaceId, MS_TEAMS_TEAM_NAME, input.teamName);
  if (input.botId != null) await upsertSecret(workspaceId, MS_TEAMS_BOT_ID, input.botId);
  if (input.serviceUrl != null) await upsertSecret(workspaceId, MS_TEAMS_SERVICE_URL, input.serviceUrl);
  if (input.appId != null) await upsertSecret(workspaceId, MS_TEAMS_APP_ID, input.appId);
  if (input.appPassword != null) await upsertSecret(workspaceId, MS_TEAMS_APP_PASSWORD, input.appPassword);

  return {
    tenantId,
    teamId: input.teamId ?? null,
    teamName: input.teamName ?? null,
    botId: input.botId ?? null,
    serviceUrl: input.serviceUrl ?? null,
    byo: Boolean(input.appId),
    orgInstalled: false,
    catalogAppId: null,
    installedAt: new Date().toISOString(),
  };
}

export async function setTeamsOrgInstalled(workspaceId: string, installed: boolean): Promise<void> {
  await upsertSecret(workspaceId, MS_TEAMS_ORG_INSTALLED, installed ? '1' : '');
}

export async function setTeamsCatalogAppId(workspaceId: string, catalogAppId: string): Promise<void> {
  await upsertSecret(workspaceId, MS_TEAMS_CATALOG_APP_ID, catalogAppId);
}

export async function loadTeamsBotCredentials(workspaceId: string): Promise<TeamsBotCredentials | null> {
  const secrets = await readTeamsSecrets(workspaceId);
  const appId = secrets[MS_TEAMS_APP_ID];
  const appPassword = secrets[MS_TEAMS_APP_PASSWORD];
  if (!appId || !appPassword) return null;
  return { appId, appPassword };
}

export async function loadTeamsAppIdForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, MS_TEAMS_APP_ID);
}

/** Update just the conversation serviceUrl — refreshed from each inbound activity. */
export async function saveTeamsServiceUrl(workspaceId: string, serviceUrl: string): Promise<void> {
  if (!serviceUrl) return;
  await upsertSecret(workspaceId, MS_TEAMS_SERVICE_URL, serviceUrl);
}

export async function loadTeamsInstall(workspaceId: string): Promise<TeamsInstallSummary | null> {
  const secrets = await readTeamsSecrets(workspaceId);
  const tenantId = secrets[MS_TEAMS_TENANT_ID];
  if (!tenantId) return null;
  const [row] = await db
    .select({ updatedAt: workspaceSecrets.updatedAt })
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, MS_TEAMS_TENANT_ID)))
    .limit(1);
  return {
    tenantId,
    teamId: secrets[MS_TEAMS_TEAM_ID] || null,
    teamName: secrets[MS_TEAMS_TEAM_NAME] || null,
    botId: secrets[MS_TEAMS_BOT_ID] || null,
    serviceUrl: secrets[MS_TEAMS_SERVICE_URL] || null,
    byo: Boolean(secrets[MS_TEAMS_APP_ID]),
    orgInstalled: Boolean(secrets[MS_TEAMS_ORG_INSTALLED]),
    catalogAppId: secrets[MS_TEAMS_CATALOG_APP_ID] || null,
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadTeamsTenantForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, MS_TEAMS_TENANT_ID);
}

export async function loadTeamsServiceUrlForWorkspace(workspaceId: string): Promise<string | null> {
  return readSecret(workspaceId, MS_TEAMS_SERVICE_URL);
}

export async function deleteTeamsInstall(workspaceId: string): Promise<void> {
  for (const name of TEAMS_KEYS) {
    await db
      .delete(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, name)));
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.workspaceId, workspaceId)));
}

async function upsertSecret(workspaceId: string, name: string, value: string): Promise<void> {
  const valueEnc = encryptWorkspaceSecret(workspaceId, value);
  const updated = await updateSharedSecret(workspaceId, name, valueEnc);
  if (updated) return;

  try {
    await db.insert(workspaceSecrets).values({
      workspaceId,
      identifier: name,
      name,
      valueEnc,
      scope: 'connector',
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    const retryUpdated = await updateSharedSecret(workspaceId, name, valueEnc);
    if (!retryUpdated) throw err;
  }
}

async function updateSharedSecret(
  workspaceId: string,
  name: string,
  valueEnc: string,
): Promise<boolean> {
  const rows = await db
    .update(workspaceSecrets)
    .set({ valueEnc, scope: 'connector', updatedAt: new Date() })
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.name, name),
        isNull(workspaceSecrets.ownerUserId),
      ),
    )
    .returning({ secretId: workspaceSecrets.secretId });
  return rows.length > 0;
}

function isUniqueConflict(err: unknown): boolean {
  const error = err as {
    code?: unknown;
    cause?: { code?: unknown; cause?: { code?: unknown } };
  };
  return (
    error?.code === '23505' ||
    error?.cause?.code === '23505' ||
    error?.cause?.cause?.code === '23505'
  );
}

async function readTeamsSecrets(workspaceId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ name: workspaceSecrets.name, valueEnc: workspaceSecrets.valueEnc })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        isNull(workspaceSecrets.ownerUserId),
        inArray(workspaceSecrets.name, TEAMS_KEYS as unknown as string[]),
      ),
    );
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!row.valueEnc) continue;
    try {
      out[row.name] = decryptWorkspaceSecret(workspaceId, row.valueEnc);
    } catch {
    }
  }
  return out;
}

async function readSecret(workspaceId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: workspaceSecrets.valueEnc })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.name, name),
        isNull(workspaceSecrets.ownerUserId),
      ),
    )
    .limit(1);
  if (!row?.valueEnc) return null;
  try {
    return decryptWorkspaceSecret(workspaceId, row.valueEnc);
  } catch {
    return null;
  }
}
