export function shouldLoadWorkspaceModelPicker(input: {
  workspaceId: string | null;
  workspaceModeKnown: boolean;
  workspaceGatewayEnabled: boolean;
}): boolean {
  return Boolean(
    input.workspaceId && (!input.workspaceModeKnown || input.workspaceGatewayEnabled),
  );
}
