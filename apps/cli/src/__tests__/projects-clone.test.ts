import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { WorkspaceSummary } from "../api/types.ts";
import {
  configureClonedWorkspaceAuth,
  resolveWorkspaceCloneTarget,
  saveClonedWorkspaceLink,
} from "../commands/workspaces.ts";
import { loadLink } from "../workspace-link.ts";

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    workspace_id: "proj_1",
    account_id: "acct_1",
    name: "Demo",
    repo_url: "https://github.com/acme/demo.git",
    default_branch: "main",
    manifest_path: "kortix.yaml",
    status: "active",
    metadata: {},
    last_opened_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("workspace clone target", () => {
  test("uses the Kortix proxy with the logged-in token when available", () => {
    expect(
      resolveWorkspaceCloneTarget(
        workspace({ git_origin_url: "https://api.kortix.com/v1/git/proj_1.git" }),
        "kortix_pat_test",
      ),
    ).toEqual({
      repoUrl: "https://api.kortix.com/v1/git/proj_1.git",
      token: "kortix_pat_test",
      username: "x-access-token",
      needsManagedToken: false,
    });
  });

  test("requests a short-lived provider token for a direct managed origin", () => {
    expect(
      resolveWorkspaceCloneTarget(
        workspace({ metadata: { git: { managed: true } } }),
        "kortix_pat_test",
      ),
    ).toEqual({
      repoUrl: "https://github.com/acme/demo.git",
      token: null,
      username: "x-access-token",
      needsManagedToken: true,
    });
  });

  test("relies on the user credential helper for direct BYO repositories", () => {
    expect(resolveWorkspaceCloneTarget(workspace(), "kortix_pat_test")).toEqual({
      repoUrl: "https://github.com/acme/demo.git",
      token: null,
      username: "x-access-token",
      needsManagedToken: false,
    });
  });
});

test("a cloned repo is bound to its workspace without dirtying git status", () => {
  const repo = mkdtempSync(resolve(tmpdir(), "kortix-workspace-clone-link-"));
  mkdirSync(resolve(repo, ".kortix"), { recursive: true });
  writeFileSync(resolve(repo, "kortix.yaml"), "kortix_version: 2\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "seed",
    ],
    { cwd: repo },
  );

  saveClonedWorkspaceLink(repo, workspace(), "dev", "https://dev-api.kortix.com");

  expect(loadLink(repo)).toMatchObject({
    workspace_id: "proj_1",
    account_id: "acct_1",
    host: "dev",
  });
  expect(
    spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })
      .stdout,
  ).toBe("");
});

test("a proxied clone installs an on-demand Kortix credential helper without storing a token", () => {
  const repo = mkdtempSync(resolve(tmpdir(), "kortix-workspace-clone-auth-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  const repoUrl = "https://dev-api.kortix.com/v1/git/proj_1.git";

  configureClonedWorkspaceAuth(repo, repoUrl, "!kortix git-credential");

  const helpers = spawnSync(
    "git",
    ["config", "--local", "--get-all", `credential.${repoUrl}.helper`],
    { cwd: repo, encoding: "utf8" },
  ).stdout.split(/\r?\n/);
  expect(helpers).toEqual(["", "!kortix git-credential", ""]);
  expect(
    spawnSync("git", ["config", "--local", "credential.useHttpPath"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim(),
  ).toBe("true");
  expect(readFileSync(resolve(repo, ".git", "config"), "utf8")).not.toContain(
    "kortix_pat_test",
  );
});
