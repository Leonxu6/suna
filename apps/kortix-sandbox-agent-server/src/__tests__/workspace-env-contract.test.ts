import { describe, expect, test } from 'bun:test'

import { loadConfig } from '../config'
import { createWorkspaceEnvStore } from '../workspace-env'

describe('workspace environment contract', () => {
  test('canonical workspace variables configure the daemon', () => {
    const config = loadConfig({
      KORTIX_WORKSPACE_ID: 'workspace-canonical',
      KORTIX_WORKSPACE_AUTO_CLONE: '1',
      KORTIX_WORKSPACE_TARGET: '/canonical',
    })

    expect(config.workspaceId).toBe('workspace-canonical')
    expect(config.autoClone).toBe(true)
    expect(config.workspaceTarget).toBe('/canonical')
  })

  test('canonical variables take precedence over deprecated project variables', () => {
    const config = loadConfig({
      KORTIX_WORKSPACE_ID: 'workspace-canonical',
      KORTIX_PROJECT_ID: 'workspace-legacy',
      KORTIX_WORKSPACE_AUTO_CLONE: '0',
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_WORKSPACE_TARGET: '/canonical',
      KORTIX_PROJECT_TARGET: '/legacy',
    })

    expect(config.workspaceId).toBe('workspace-canonical')
    expect(config.autoClone).toBe(false)
    expect(config.workspaceTarget).toBe('/canonical')
  })

  test('deprecated project variables remain valid fallbacks', () => {
    const config = loadConfig({
      KORTIX_PROJECT_ID: 'workspace-legacy',
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_PROJECT_TARGET: '/legacy',
    })

    expect(config.workspaceId).toBe('workspace-legacy')
    expect(config.autoClone).toBe(true)
    expect(config.workspaceTarget).toBe('/legacy')
  })

  test('workspace secret metadata takes precedence over deprecated metadata', () => {
    const store = createWorkspaceEnvStore({
      KORTIX_WORKSPACE_SECRETS_REVISION: 'workspace-revision',
      KORTIX_PROJECT_SECRETS_REVISION: 'project-revision',
      KORTIX_WORKSPACE_SECRET_NAMES: 'WORKSPACE_SECRET',
      KORTIX_PROJECT_SECRET_NAMES: 'PROJECT_SECRET',
      WORKSPACE_SECRET: 'workspace-value',
      PROJECT_SECRET: 'project-value',
    })

    expect(store.snapshot()).toEqual({
      revision: 'workspace-revision',
      names: ['WORKSPACE_SECRET'],
      knownNames: ['WORKSPACE_SECRET'],
      env: { WORKSPACE_SECRET: 'workspace-value' },
    })
  })

  test('deprecated secret metadata remains a valid fallback', () => {
    const store = createWorkspaceEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'project-revision',
      KORTIX_PROJECT_SECRET_NAMES: 'PROJECT_SECRET',
      PROJECT_SECRET: 'project-value',
    })

    expect(store.snapshot()).toEqual({
      revision: 'project-revision',
      names: ['PROJECT_SECRET'],
      knownNames: ['PROJECT_SECRET'],
      env: { PROJECT_SECRET: 'project-value' },
    })
  })
})
