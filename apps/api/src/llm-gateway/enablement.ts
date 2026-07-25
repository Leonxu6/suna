import { resolveExperimentalFeature } from '../experimental/features';

/** True only when the platform gateway is available and this workspace opted in. */
export function workspaceLlmGatewayEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'llm_gateway');
}
