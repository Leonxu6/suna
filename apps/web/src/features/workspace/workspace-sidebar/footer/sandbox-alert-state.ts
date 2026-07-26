import type { WorkspaceSandboxHealth, WorkspaceSnapshotBuild } from '@kortix/sdk';

export type SandboxAlertSeverity = 'critical' | 'building';

function isWorkspaceAcceleratorBuild(build: WorkspaceSnapshotBuild | null | undefined): boolean {
  return build?.snapshot_name.startsWith('kortix-ppwarm-') ?? false;
}

export function selectCurrentSandboxFailure(
  health: WorkspaceSandboxHealth | null | undefined,
): WorkspaceSnapshotBuild | null {
  const failure = health?.latest_failure ?? null;
  if (!failure) return null;
  if (isWorkspaceAcceleratorBuild(failure)) return null;

  const latest = health?.latest_build ?? null;
  if (latest && latest.build_id !== failure.build_id) return null;

  return failure;
}

export function resolveSandboxAlertSeverity(
  health: WorkspaceSandboxHealth | null | undefined,
): SandboxAlertSeverity | null {
  if (!health) return null;
  if (selectCurrentSandboxFailure(health) && !health.ready) return 'critical';
  if (health.building && !health.ready && !isWorkspaceAcceleratorBuild(health.latest_build)) {
    return 'building';
  }
  return null;
}

export function currentFailedBuild<T extends { status: WorkspaceSnapshotBuild['status'] }>(
  builds: readonly T[],
): T | null {
  const latest =
    builds.find(
      (build) =>
        !(
          'snapshot_name' in build &&
          typeof build.snapshot_name === 'string' &&
          build.snapshot_name.startsWith('kortix-ppwarm-')
        ),
    ) ?? null;
  return latest?.status === 'failed' ? latest : null;
}
