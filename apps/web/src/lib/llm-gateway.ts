import type { KortixWorkspace } from '@kortix/sdk';

/** True when this workspace routes LLM calls through the managed gateway. */
export function isLlmGatewayEnabled(workspace: KortixWorkspace | undefined): boolean {
  if (!workspace) return false;
  if (workspace.experimental?.llm_gateway === true) return true;
  return (
    workspace.experimental_features?.some(
      (feature) => feature.key === 'llm_gateway' && feature.enabled,
    ) ?? false
  );
}

/** True when the platform exposes LLM Gateway for this workspace (may still be toggled off). */
export function isLlmGatewayAvailable(workspace: KortixWorkspace | undefined): boolean {
  return (
    workspace?.experimental_features?.some(
      (feature) => feature.key === 'llm_gateway' && feature.available,
    ) ?? false
  );
}
