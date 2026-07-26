'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldAlert,
  UserRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { InfoBanner } from '@/components/ui/info-banner';
import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';
import { Textarea } from '@/components/ui/textarea';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useAuth } from '@/features/providers/auth-provider';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { getWorkspace, requestWorkspaceAccess, setAdminBypass } from '@kortix/sdk';
import { cn } from '@/lib/utils';

interface WorkspaceAccessBoundaryProps {
  workspaceId: string;
  children: ReactNode;
}

function errorStatus(error: unknown): number | undefined {
  return (
    (error as { status?: number; response?: { status?: number } } | null)?.status ??
    (error as { response?: { status?: number } } | null)?.response?.status
  );
}

export function WorkspaceAccessBoundary({ workspaceId, children }: WorkspaceAccessBoundaryProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const query = useQuery({
    queryKey: ['workspace-access-boundary', workspaceId],
    queryFn: () => getWorkspace(workspaceId, { showErrors: false }),
    enabled: !!workspaceId,
    retry: false,
  });

  if (query.isLoading) {
    return <WorkspaceAccessLoading />;
  }

  if (query.isError) {
    const status = errorStatus(query.error);
    if (status === 403) {
      return <ForbiddenWorkspaceState workspaceId={workspaceId} />;
    }

    if (status === 404) {
      return (
        <WorkspaceAccessStateFrame
          icon={<AlertCircle className="size-5" />}
          eyebrow={tI18nHardcoded.raw(
            'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrEyebrowWorkspaceUnavailablea0231815',
          )}
          title={tI18nHardcoded.raw(
            'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrTitleWorkspaceNotc66b9822',
          )}
          description={tI18nHardcoded.raw(
            'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrDescriptionThisWorkspace92b78195',
          )}
        />
      );
    }

    return (
      <WorkspaceAccessStateFrame
        icon={<AlertCircle className="size-5" />}
        eyebrow={tI18nHardcoded.raw(
          'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrEyebrowWorkspaceUnavailablea0231815',
        )}
        title={tI18nHardcoded.raw(
          'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrTitleCouldnT870a862d',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrDescriptionSomethingWent8997618a',
        )}
        footer={
          <Button type="button" variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        }
      />
    );
  }

  return <>{children}</>;
}

function WorkspaceAccessLoading() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div
      className="bg-background flex min-h-screen items-center justify-center"
      role="status"
      aria-label={tI18nHardcoded.raw(
        'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrAriaLabelLoading21cf6b95',
      )}
    >
      <KortixHyperLogo size={34} startOnView={false} animateOnHover={false} />
    </div>
  );
}

function ForbiddenWorkspaceState({ workspaceId }: { workspaceId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: adminRole } = useAdminRole();
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [bypassError, setBypassError] = useState<string | null>(null);

  const requestMutation = useMutation({
    mutationFn: () => requestWorkspaceAccess(workspaceId, message),
    onMutate: () => setInlineError(null),
    onSuccess: (result) => {
      if (result.status === 'already_has_access') {
        void queryClient.invalidateQueries({
          queryKey: ['workspace-access-boundary', workspaceId],
        });
        return;
      }
      setSent(true);
    },
    onError: (error: Error) => {
      setInlineError(error.message || 'Could not send access request.');
    },
  });

  // Platform-admin escape hatch: flips the client-wide admin-bypass header
  // on, then re-fetches this same ['workspace-access-boundary', workspaceId] query so the
  // boundary above (which shares this query cache) picks up the result and
  // renders the actual workspace. Read-only server-side (see
  // apps/api/src/workspaces/lib/access.ts) and audit-logged against the
  // workspace's own account on every use.
  const bypassMutation = useMutation({
    mutationFn: async () => {
      setAdminBypass(true);
      return queryClient.fetchQuery({
        queryKey: ['workspace-access-boundary', workspaceId],
        queryFn: () => getWorkspace(workspaceId, { showErrors: false }),
      });
    },
    onMutate: () => setBypassError(null),
    onError: (error: Error) => {
      setAdminBypass(false);
      setBypassError(error.message || 'Admin bypass failed.');
    },
  });

  return (
    <WorkspaceAccessStateFrame
      icon={<LockKeyhole className="size-5" />}
      cornerAction={
        adminRole?.isAdmin ? (
          <div className="flex flex-col items-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
              onClick={() => bypassMutation.mutate()}
              disabled={bypassMutation.isPending}
            >
              {bypassMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldAlert className="size-3.5" />
              )}
              ADMIN BYPASS
            </Button>
            {bypassError ? <p className="text-destructive text-xs">{bypassError}</p> : null}
          </div>
        ) : null
      }
      eyebrow={tI18nHardcoded.raw(
        'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrEyebrowPrivateWorkspaced5b1951c',
      )}
      title={sent ? 'Request sent.' : 'Request access to this workspace.'}
      description={
        sent
          ? 'A workspace manager can approve you from the Members screen. Keep this page open and check again once they approve the request.'
          : 'This Kortix workspace is private. Send a short note and a workspace manager can add you as a viewer.'
      }
      panelTitle={sent ? 'Waiting for approval' : 'Access request'}
      panelDescription={
        sent
          ? 'Managers have the request in Customize → Members.'
          : 'A little context helps the manager approve the right account.'
      }
      content={
        <div className="space-y-4">
          {sent ? (
            <InfoBanner
              tone="success"
              icon={CheckCircle2}
              title={tI18nHardcoded.raw(
                'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrTitleRequestSent6567e02d',
              )}
            >
              {tI18nHardcoded.raw(
                'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxTextWorkspaceManagersWill08e33ff7',
              )}
            </InfoBanner>
          ) : (
            <>
              <InfoBanner
                tone="neutral"
                icon={UserRound}
                title={tI18nHardcoded.raw(
                  'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrTitleSignedIna3165363',
                )}
              >
                <span className="text-muted-foreground">
                  {tI18nHardcoded.raw(
                    'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxTextRequestingAccessAs09b70479',
                  )}{' '}
                  <span className="text-foreground font-medium">
                    {user?.email ?? user?.id ?? 'this account'}
                  </span>
                  .
                </span>
              </InfoBanner>

              <div className="space-y-2">
                <label
                  className="text-foreground text-sm font-medium"
                  htmlFor="workspace-access-message"
                >
                  Message <span className="text-muted-foreground font-normal">optional</span>
                </label>
                <Textarea
                  id="workspace-access-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  minHeight={96}
                  maxHeight={160}
                  placeholder={tI18nHardcoded.raw(
                    'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxAttrPlaceholderTellThec2bb0f7d',
                  )}
                  disabled={requestMutation.isPending}
                />
                {inlineError ? <p className="text-destructive text-xs">{inlineError}</p> : null}
              </div>
            </>
          )}
        </div>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => router.push('/workspaces')}>
            <ArrowLeft className="size-4" />
            {tI18nHardcoded.raw(
              'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxTextBackToWorkspaces9ad9ccd3',
            )}
          </Button>
          {sent ? (
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="size-4" />
              {tI18nHardcoded.raw(
                'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxTextCheckAgain9f1e6458',
              )}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => requestMutation.mutate()}
              disabled={requestMutation.isPending}
            >
              {requestMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {tI18nHardcoded.raw(
                'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxTextRequestAccess870ec6e1',
              )}
            </Button>
          )}
        </div>
      }
    />
  );
}

function WorkspaceAccessStateFrame({
  icon,
  eyebrow = 'Workspace access',
  title,
  description,
  panelTitle,
  panelDescription,
  content,
  footer,
  cornerAction,
}: {
  icon: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  panelTitle?: string;
  panelDescription?: string;
  content?: ReactNode;
  footer?: ReactNode;
  cornerAction?: ReactNode;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const router = useRouter();
  const action = footer ?? (
    <Button type="button" variant="outline" onClick={() => router.push('/workspaces')}>
      <ArrowLeft className="size-4" />
      {tI18nHardcoded.raw(
        'autoComponentsWorkspacesWorkspaceAccessBoundaryJsxTextBackToWorkspaces9ad9ccd3',
      )}
    </Button>
  );

  return (
    <div className="bg-background relative flex min-h-screen overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 opacity-60" aria-hidden="true">
        <WallpaperBackground />
      </div>
      <div
        className="bg-background/85 dark:bg-background/80 pointer-events-none absolute inset-0"
        aria-hidden="true"
      />

      {cornerAction ? (
        <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">{cornerAction}</div>
      ) : null}

      <main className="relative z-10 mx-auto flex w-full max-w-4xl items-center">
        <div
          className={cn(
            'grid w-full gap-6',
            content ? 'lg:grid-cols-2 lg:items-start' : 'max-w-2xl',
          )}
        >
          <section className="space-y-5">
            <div className="border-border/70 bg-card text-foreground flex size-11 items-center justify-center rounded-2xl border shadow-2xs">
              {icon}
            </div>

            <div className="space-y-3">
              <Badge variant="outline" size="sm" className="w-fit">
                {eyebrow}
              </Badge>
              <div className="space-y-3">
                <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                  {title}
                </h1>
                <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
                  {description}
                </p>
              </div>
            </div>

            {!content ? <div className="pt-1">{action}</div> : null}
          </section>

          {content ? (
            <Card className="border-border/70 bg-card/90 gap-0 overflow-hidden rounded-2xl py-0 shadow-2xs backdrop-blur-sm">
              <CardHeader className="border-border/60 border-b px-6 py-4">
                <CardTitle className="text-base">{panelTitle ?? 'Request access'}</CardTitle>
                {panelDescription ? (
                  <CardDescription className="text-xs leading-relaxed">
                    {panelDescription}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="px-6 py-5">{content}</CardContent>
              <CardFooter className="border-border/60 bg-muted/30 border-t px-6 py-3">
                {action}
              </CardFooter>
            </Card>
          ) : null}
        </div>
      </main>
    </div>
  );
}
