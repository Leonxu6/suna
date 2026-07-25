import {
  sandboxes,
  kortixApiKeys,
  accounts,
  accountMembers,
  accountInvitations,
  accountGithubInstallations,
  auditEvents,
  usageEvents,
  gatewayRequestLogs,
  gatewayApiKeys,
  gatewayBudgets,
  workspaces,
  workspaceGitConnections,
  workspaceGitCredentials,
  workspaceMembers,
  workspaceSecrets,
  workspaceSessions,
  workspaceSnapshotBuilds,
  sandboxTemplates,
  sessionSandboxes,
  legacySandboxMigrations,
  creditAccounts,
  tunnelConnections,
  tunnelPermissions,
  tunnelPermissionRequests,
  tunnelAuditLogs,
  chatChannelBindings,
  chatInstalls,
  chatThreads,
} from './schema/kortix';
import { apiKeys } from './schema/public';

// Select types (what you get back from queries)
export type Account = typeof accounts.$inferSelect;
export type AccountMember = typeof accountMembers.$inferSelect;
export type AccountInvitation = typeof accountInvitations.$inferSelect;
export type AccountGithubInstallation = typeof accountGithubInstallations.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type NewAccountMember = typeof accountMembers.$inferInsert;
export type NewAccountInvitation = typeof accountInvitations.$inferInsert;
export type NewAccountGithubInstallation = typeof accountGithubInstallations.$inferInsert;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type GatewayRequestLog = typeof gatewayRequestLogs.$inferSelect;
export type NewGatewayRequestLog = typeof gatewayRequestLogs.$inferInsert;
export type GatewayApiKey = typeof gatewayApiKeys.$inferSelect;
export type NewGatewayApiKey = typeof gatewayApiKeys.$inferInsert;
export type GatewayBudget = typeof gatewayBudgets.$inferSelect;
export type NewGatewayBudget = typeof gatewayBudgets.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceGitConnection = typeof workspaceGitConnections.$inferSelect;
export type NewWorkspaceGitConnection = typeof workspaceGitConnections.$inferInsert;
export type WorkspaceGitCredential = typeof workspaceGitCredentials.$inferSelect;
export type NewWorkspaceGitCredential = typeof workspaceGitCredentials.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type WorkspaceSecret = typeof workspaceSecrets.$inferSelect;
export type NewWorkspaceSecret = typeof workspaceSecrets.$inferInsert;
export type WorkspaceSession = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSession = typeof workspaceSessions.$inferInsert;
export type WorkspaceSnapshotBuild = typeof workspaceSnapshotBuilds.$inferSelect;
export type NewWorkspaceSnapshotBuild = typeof workspaceSnapshotBuilds.$inferInsert;
export type SandboxTemplate = typeof sandboxTemplates.$inferSelect;
export type NewSandboxTemplate = typeof sandboxTemplates.$inferInsert;
export type SessionSandbox = typeof sessionSandboxes.$inferSelect;
export type NewSessionSandbox = typeof sessionSandboxes.$inferInsert;
export type LegacySandboxMigration = typeof legacySandboxMigrations.$inferSelect;
export type NewLegacySandboxMigration = typeof legacySandboxMigrations.$inferInsert;
export type Sandbox = typeof sandboxes.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type CreditAccount = typeof creditAccounts.$inferSelect;
export type KortixApiKey = typeof kortixApiKeys.$inferSelect;

// Insert types (what you pass to inserts)
export type NewSandbox = typeof sandboxes.$inferInsert;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type NewKortixApiKey = typeof kortixApiKeys.$inferInsert;
export type ChatChannelBinding = typeof chatChannelBindings.$inferSelect;
export type NewChatChannelBinding = typeof chatChannelBindings.$inferInsert;
export type ChatInstall = typeof chatInstalls.$inferSelect;
export type NewChatInstall = typeof chatInstalls.$inferInsert;
export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;

// Tunnel
export type TunnelConnection = typeof tunnelConnections.$inferSelect;
export type NewTunnelConnection = typeof tunnelConnections.$inferInsert;
export type TunnelPermission = typeof tunnelPermissions.$inferSelect;
export type NewTunnelPermission = typeof tunnelPermissions.$inferInsert;
export type TunnelPermissionRequest = typeof tunnelPermissionRequests.$inferSelect;
export type NewTunnelPermissionRequest = typeof tunnelPermissionRequests.$inferInsert;
export type TunnelAuditLog = typeof tunnelAuditLogs.$inferSelect;
export type NewTunnelAuditLog = typeof tunnelAuditLogs.$inferInsert;

// Aliases
export type SandboxSelect = Sandbox;
