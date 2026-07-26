'use client';

import { useTranslations } from 'next-intl';

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

import { useDebounce } from '@/hooks/use-debounce';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/features/icon/icon';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  archiveWorkspace,
  getWorkspace,
  inviteRepoCollaborator,
  isManagedGithubWorkspace,
  listWorkspaceBranches,
  listWorkspaceTriggers,
  setWorkspaceTriggersActivation,
  updateExperimentalFeature,
  updateWorkspace,
  updateWorkspaceSandboxProvider,
  type ExperimentalFeatureView,
  type KortixWorkspace,
  type WorkspaceDetail,
  type SandboxProviderName,
} from '@kortix/sdk';
import {
  applySandboxProviderResult,
  pollSandboxProviderTransition,
} from './sandbox-provider-result';
import { refreshWorkspaceProviderState } from '@kortix/sdk/react';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { TrashSolid } from '@mynaui/icons-react';
import CustomizeSectionWrapper from '../component/section-wrapper';

export function SettingsView({ workspaceId }: { workspaceId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);

  const workspaceQuery = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => getWorkspace(workspaceId),
    staleTime: 20_000,
  });

  const workspace = workspaceQuery.data;
  const canManage = workspace?.effective_workspace_role === 'manager';
  // Real per-leaf write cap: a custom role granted workspace.write edits the
  // general controls (name/repo/experimental) without being a full manager.
  // The mutating routes assert workspace.write, so a READ-only role sees the
  // section read-only. Archive/danger-zone stays manager-only below.
  const canWrite = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_WRITE).allowed === true;
  const canEdit = canManage || canWrite;

  const archiveMutation = useMutation({
    mutationFn: () => archiveWorkspace(workspaceId),
    onSuccess: () => {
      successToast('Workspace archived');
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setArchiveOpen(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to archive workspace'),
  });

  return (
    <CustomizeSectionWrapper title="Settings" description="Manage your workspace settings">
      {workspaceQuery.isLoading && (
        <div className="space-y-5">
          <Skeleton className="h-56 rounded-md" />
          <Skeleton className="h-72 rounded-md" />
        </div>
      )}

      {workspaceQuery.isError && (
        <ErrorState
          size="sm"
          title={tHardcodedUi.raw(
            'appWorkspacesIdCustomizeSettingsPage.line86JsxAttrTitleFailedToLoadWorkspace',
          )}
          description={(workspaceQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => workspaceQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {workspace && (
        <div className="space-y-8">
          <GeneralWorkspaceCard workspace={workspace} canManage={canEdit} />
          <RepositoryCard workspace={workspace} canManage={canEdit} />
          {canManage && (
            <section className="space-y-4">
              <Label>Automation</Label>
              <TriggersActivationCard workspaceId={workspaceId} canManage={canEdit} />
            </section>
          )}
          <ExperimentalCard workspace={workspace} canManage={canEdit} />
          {canManage && (
            <section className="space-y-4">
              <Label>
                {tHardcodedUi.raw(
                  'appWorkspacesIdCustomizeSettingsPage.line110JsxAttrTitleDangerZone',
                )}
              </Label>
              <div className="bg-popover rounded-md border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">
                      {tHardcodedUi.raw(
                        'appWorkspacesIdCustomizeSettingsPage.line116JsxTextArchiveWorkspace',
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                      {tHardcodedUi.raw(
                        'appWorkspacesIdCustomizeSettingsPage.line119JsxTextHideThisWorkspaceFromTheActiveWorkspaceList',
                      )}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    className="shrink-0"
                    size="sm"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <TrashSolid className="size-4" />
                    Archive
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={tHardcodedUi.raw(
          'appWorkspacesIdCustomizeSettingsPage.line140JsxAttrTitleArchiveWorkspace',
        )}
        description={workspace ? `Archive ${workspace.name}? Current sessions remain recoverable.` : ''}
        confirmLabel="Archive"
        onConfirm={() => archiveMutation.mutate()}
        isPending={archiveMutation.isPending}
      />
    </CustomizeSectionWrapper>
  );
}

function RepositoryCard({ workspace, canManage }: { workspace: KortixWorkspace; canManage: boolean }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const repoUrl = workspace.repo_url;
  const githubUrl = githubRepoWebUrl(repoUrl);
  const repoLabel = githubUrl?.replace('https://github.com/', '') || repoUrl || '-';
  const managed = isManagedGithubWorkspace(workspace);
  const branchesQuery = useQuery({
    queryKey: ['workspace-branches', workspace.workspace_id],
    queryFn: () => listWorkspaceBranches(workspace.workspace_id),
    staleTime: 60_000,
  });
  const branchNames = Array.from(
    new Set([
      workspace.default_branch,
      ...(branchesQuery.data?.branches.map((branch) => branch.name) ?? []),
    ]),
  );

  const [defaultBranch, setDefaultBranch] = useState(workspace.default_branch);
  const [manifestPath, setManifestPath] = useState(workspace.manifest_path);
  const { debouncedValue: debouncedBranch, isLoading: isDebouncingBranch } = useDebounce(
    defaultBranch,
    500,
  );
  const { debouncedValue: debouncedManifest, isLoading: isDebouncingManifest } = useDebounce(
    manifestPath,
    500,
  );

  useEffect(() => {
    setDefaultBranch(workspace.default_branch);
    setManifestPath(workspace.manifest_path);
  }, [workspace.default_branch, workspace.manifest_path]);

  const mutation = useMutation({
    mutationFn: (patch: { default_branch: string; manifest_path: string }) =>
      updateWorkspace(workspace.workspace_id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workspace', workspace.workspace_id], updated);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-branches', workspace.workspace_id] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update repository'),
  });

  const { mutate, isPending } = mutation;

  useEffect(() => {
    if (!canManage || isPending) return;

    const branch = debouncedBranch.trim();
    const manifest = debouncedManifest.trim();
    if (!branch) return;
    if (branch === workspace.default_branch && manifest === workspace.manifest_path) return;

    mutate({ default_branch: branch, manifest_path: manifest });
  }, [
    debouncedBranch,
    debouncedManifest,
    canManage,
    workspace.default_branch,
    workspace.manifest_path,
    isPending,
    mutate,
  ]);

  const saving = isDebouncingBranch || isDebouncingManifest || isPending;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Label>Repository</Label>
        {githubUrl ? (
          <Button asChild variant="transparent" size="sm">
            <Link href={githubUrl} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="default-branch">
                {tHardcodedUi.raw('appWorkspacesIdCustomizeSettingsPage.line270JsxTextDefaultBranch')}
              </FieldLabel>
              {saving ? <SaveStatus /> : null}
            </div>
            <Select
              value={defaultBranch}
              onValueChange={setDefaultBranch}
              disabled={!canManage || isPending}
            >
              <SelectTrigger id="default-branch" className="font-mono text-xs" variant="popover">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((branch) => (
                  <SelectItem key={branch} value={branch} className="font-mono text-xs">
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              New sessions and change requests use this branch as their base.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="manifest-path">
              {tHardcodedUi.raw('appWorkspacesIdCustomizeSettingsPage.line280JsxTextManifestPath')}
            </FieldLabel>
            <Input
              id="manifest-path"
              value={manifestPath}
              onChange={(e) => setManifestPath(e.target.value)}
              disabled={!canManage || isPending}
              className="font-mono text-xs"
              variant="popover"
            />
          </Field>
        </FieldGroup>

        {managed ? (
          <div className="border-border/60 border-t pt-5">
            <RepoCollaboratorInvite workspaceId={workspace.workspace_id} canManage={canManage} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ExperimentalCard({ workspace, canManage }: { workspace: KortixWorkspace; canManage: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const features = (workspace.experimental_features ?? []).filter((f) => f.available);
  const [expanded, setExpanded] = useState(false);

  if (features.length === 0) return null;

  return (
    <section className="space-y-4">
      <Label>
        {tI18nHardcoded.raw(
          'autoComponentsWorkspacesCustomizeSectionsSettingsViewJsxTextExperimentalWIPcb2304ee',
        )}
      </Label>
      <Disclosure
        open={expanded}
        onOpenChange={setExpanded}
        variant="outline"
        className="group bg-popover overflow-hidden"
      >
        <DisclosureTrigger className="px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">
              {features.length} feature{features.length === 1 ? '' : 's'}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
              Early-access capabilities that may change or be removed.
            </p>
          </div>
        </DisclosureTrigger>
        <DisclosureContent contentClassName="border-border border-t">
          <div className="divide-border divide-y">
            {features.map((feature) => (
              <ExperimentalFeatureRow
                key={feature.key}
                workspaceId={workspace.workspace_id}
                feature={feature}
                canManage={canManage}
              />
            ))}
            <SandboxProviderRow workspace={workspace} canManage={canManage} />
          </div>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
}

function ExperimentalFeatureRow({
  workspaceId,
  feature,
  canManage,
}: {
  workspaceId: string;
  feature: ExperimentalFeatureView;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  // Show the intended position while the request is in flight. `feature.enabled`
  // only reflects server state, so without this the switch does not move at all
  // until the mutation resolves and a slow request looks like a frozen toggle.
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  const mutation = useMutation({
    mutationFn: (next: boolean) => updateExperimentalFeature(workspaceId, feature.key, next),
    onSettled: () => setPendingValue(null),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workspace', workspaceId], updated);
      queryClient.setQueryData<WorkspaceDetail | undefined>(
        ['workspace-detail', workspaceId],
        (current) => (current ? { ...current, workspace: updated } : current),
      );
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      if (feature.key === 'llm_gateway') {
        refreshWorkspaceProviderState(queryClient, workspaceId, { removeWorkspaceScopedCache: true });
      }
    },
    onError: (error: Error) => errorToast(error.message || `Failed to update ${feature.name}`),
  });

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-foreground text-sm font-medium">{feature.name}</p>
          <Badge variant={feature.stability === 'beta' ? 'beta' : 'highlight'} size="sm">
            {feature.stability === 'beta' ? 'Beta' : 'Experimental'}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{feature.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {mutation.isPending ? (
          <Loading className="text-muted-foreground size-3.5 animate-spin" />
        ) : null}
        <Switch
          checked={pendingValue ?? feature.enabled}
          disabled={!canManage || mutation.isPending}
          onCheckedChange={(v) => {
            setPendingValue(v);
            mutation.mutate(v);
          }}
        />
      </div>
    </div>
  );
}

// Per-workspace sandbox-provider pin — rendered as a row INSIDE the Experimental list.
// Overrides the platform's weighted distribution for THIS workspace only (e.g. put one
// workspace on Platinum even when the fleet is mostly Daytona). Options come from the
// workspace payload (`available_sandbox_providers` = the usable set). Hidden only when
// no provider is usable.
const AUTO_PROVIDER = '__auto__';
function SandboxProviderRow({
  workspace,
  canManage,
}: {
  workspace: KortixWorkspace;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const available = workspace.available_sandbox_providers ?? [];
  const current = workspace.default_sandbox_provider ?? null;
  const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  const mutation = useMutation({
    mutationFn: (next: SandboxProviderName | null) =>
      updateWorkspaceSandboxProvider(workspace.workspace_id, next),
    onSuccess: (result, next) => {
      // FIX-L: the PATCH returns EITHER the updated workspace (immediate) OR a
      // preparation object (the prepare branch — a switch to a different enabled
      // provider). Write the workspace cache ONLY for the immediate result; a
      // preparation is a transition, not a workspace, and must not clobber the
      // cached workspace shape.
      const kind = applySandboxProviderResult(queryClient, workspace.workspace_id, result);
      if (kind === 'preparation') {
        successToast(`Preparing ${next ? label(next) : 'the sandbox provider'}… this can take a few minutes`);
        // Poll the durable transition (bounded, backoff, terminal-stop, 404 = done)
        // and refresh the workspace once it settles so the now-active provider shows.
        void pollSandboxProviderTransition(workspace.workspace_id, {
          onSettled: (state) => {
            queryClient.invalidateQueries({ queryKey: ['workspace', workspace.workspace_id] });
            queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspace.workspace_id] });
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            const status = state?.latest?.status;
            if (status === 'activated') {
              successToast(`Switched to ${label(state?.latest?.target_provider ?? '')}`);
            } else if (status === 'failed') {
              errorToast(state?.latest?.label || 'Sandbox provider switch failed');
            }
          },
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update sandbox provider'),
  });

  if (available.length === 0) return null;

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-foreground text-sm font-medium">Sandbox provider</p>
          <Badge variant="highlight" size="sm">
            Experimental
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          Pin this workspace to a specific sandbox provider, overriding the platform
          default. New sessions here run on the chosen provider — “Automatic” follows
          the platform default.
        </p>
      </div>
      <Select
        value={current ?? AUTO_PROVIDER}
        onValueChange={(v) =>
          mutation.mutate(v === AUTO_PROVIDER ? null : available.find((provider) => provider === v) ?? null)
        }
        disabled={!canManage || mutation.isPending}
      >
        <SelectTrigger className="w-40 shrink-0" variant="popover">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_PROVIDER}>Automatic</SelectItem>
          {available.map((p) => (
            <SelectItem key={p} value={p}>
              {label(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TriggersActivationCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['workspace-triggers', workspaceId];
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listWorkspaceTriggers(workspaceId),
    staleTime: 10_000,
  });
  const paused = triggersQuery.data?.triggers_paused ?? false;

  const mutation = useMutation({
    mutationFn: (next: boolean) => setWorkspaceTriggersActivation(workspaceId, next),
    onSuccess: (data, next) => {
      queryClient.setQueryData(queryKey, data);
      successToast(next ? 'All triggers paused for this workspace' : 'Triggers resumed');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update trigger activation'),
  });

  return (
    <Field orientation="horizontal" className="bg-popover rounded-md border px-4 py-3">
      <FieldContent>
        <FieldTitle>
          Pause all triggers
          {paused && <span className="text-muted-foreground font-normal"> · paused</span>}
        </FieldTitle>
        <FieldDescription>
          Dev kill-switch — stop the platform auto-running this workspace&apos;s schedules &amp;
          webhooks (manual test-fires still work). Use it when another environment owns the
          triggers.
        </FieldDescription>
      </FieldContent>
      <Switch
        checked={paused}
        disabled={!canManage || mutation.isPending || triggersQuery.isLoading}
        onCheckedChange={(v) => mutation.mutate(v)}
        aria-label="Pause all triggers for this workspace"
      />
    </Field>
  );
}

function RepoCollaboratorInvite({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');

  const inviteMutation = useMutation({
    mutationFn: () => inviteRepoCollaborator(workspaceId, username.trim(), permission),
    onSuccess: (res) => {
      if (res.alreadyCollaborator) {
        successToast(`@${res.username} already has access to this repo`);
      } else {
        successToast(`Invite sent to @${res.username} — they accept it on GitHub to get access`);
      }
      setUsername('');
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add collaborator'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    if (username.trim() && !inviteMutation.isPending) inviteMutation.mutate();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">
          {tI18nHardcoded.raw(
            'autoComponentsWorkspacesCustomizeSectionsSettingsViewJsxTextAddPeople18915e9b',
          )}
        </p>
        <p className="text-muted-foreground text-xs text-pretty">
          Invite GitHub collaborators to this repository.
        </p>
      </div>

      {canManage ? (
      <form onSubmit={submit}>
        <FieldGroup className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_auto] sm:items-end sm:gap-x-3">
            <Field>
              <div className="relative min-w-0">
                <Icon.Github className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  id="repo-collaborator-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={tI18nHardcoded.raw(
                    'autoComponentsWorkspacesCustomizeSectionsSettingsViewJsxAttrPlaceholderGitHub84efb7a1',
                  )}
                  variant="popover"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="pl-9"
                />
              </div>
            </Field>

            <Field>
              <Select
                value={permission}
                onValueChange={(v) => setPermission(v as 'read' | 'write')}
              >
                <SelectTrigger
                  id="repo-collaborator-permission"
                  className="w-full"
                  variant="popover"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="write">
                    {tI18nHardcoded.raw(
                      'autoComponentsWorkspacesCustomizeSectionsSettingsViewJsxTextCanEdit2eb88c1b',
                    )}
                  </SelectItem>
                  <SelectItem value="read">
                    {tI18nHardcoded.raw(
                      'autoComponentsWorkspacesCustomizeSectionsSettingsViewJsxTextCanView39f4dd36',
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <Button
                type="submit"
                className="w-full shrink-0 sm:w-auto"
                disabled={!username.trim() || inviteMutation.isPending}
              >
                {inviteMutation.isPending ? <Loading className="size-3.5 animate-spin" /> : null}
                Add
              </Button>
            </Field>
          </div>
        </FieldGroup>
      </form>
      ) : null}
    </div>
  );
}

function githubRepoWebUrl(repoUrl: string | null | undefined): string | null {
  const normalized = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!normalized) return null;

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) {
    return `https://github.com/${ssh[1]}/${ssh[2]}`;
  }

  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) {
    return `https://github.com/${https[1]}/${https[2]}`;
  }

  return null;
}

function GeneralWorkspaceCard({
  workspace,
  canManage,
}: {
  workspace: Awaited<ReturnType<typeof getWorkspace>>;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const { debouncedValue: debouncedName, isLoading: isDebouncing } = useDebounce(name, 500);

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.name]);

  const mutation = useMutation({
    mutationFn: (nextName: string) =>
      updateWorkspace(workspace.workspace_id, {
        name: nextName,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workspace', workspace.workspace_id], updated);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update workspace'),
  });

  const { mutate, isPending } = mutation;

  useEffect(() => {
    if (!canManage || isPending) return;

    const trimmed = debouncedName.trim();
    if (!trimmed || trimmed === workspace.name) return;

    mutate(trimmed);
  }, [debouncedName, canManage, workspace.name, isPending, mutate]);

  const saving = isDebouncing || isPending;

  return (
    <section className="space-y-4">
      <Label htmlFor="workspace-name">General</Label>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="workspace-name">
            {tHardcodedUi.raw('appWorkspacesIdCustomizeSettingsPage.line259JsxTextWorkspaceName')}
          </FieldLabel>
          {saving ? <SaveStatus /> : null}
        </div>
        <Input
          id="workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage || isPending}
          maxLength={120}
          variant="popover"
        />
      </Field>
    </section>
  );
}

function SaveStatus() {
  return <span className="text-muted-foreground shrink-0 text-xs tabular-nums">Saving…</span>;
}
