import { describe, expect, test } from "bun:test";

import { shouldLoadWorkspaceModelPicker } from "./provider-load-plan";

describe("shouldLoadWorkspaceModelPicker", () => {
  test("starts the model-picker request while workspace detail is unresolved", () => {
    expect(
      shouldLoadWorkspaceModelPicker({
        workspaceId: "workspace-1",
        workspaceModeKnown: false,
        workspaceGatewayEnabled: false,
      }),
    ).toBe(true);
  });

  test("keeps the model-picker request enabled for a gateway workspace", () => {
    expect(
      shouldLoadWorkspaceModelPicker({
        workspaceId: "workspace-1",
        workspaceModeKnown: true,
        workspaceGatewayEnabled: true,
      }),
    ).toBe(true);
  });

  test("does not request the gateway model-picker for a known native workspace", () => {
    expect(
      shouldLoadWorkspaceModelPicker({
        workspaceId: "workspace-1",
        workspaceModeKnown: true,
        workspaceGatewayEnabled: false,
      }),
    ).toBe(false);
  });

  test("does not request a workspace model-picker outside a workspace route", () => {
    expect(
      shouldLoadWorkspaceModelPicker({
        workspaceId: null,
        workspaceModeKnown: true,
        workspaceGatewayEnabled: false,
      }),
    ).toBe(false);
  });
});
