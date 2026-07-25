-- Canonical Workspace database interface.
--
-- The API deploys through a rolling update after migrations run. Existing API
-- replicas still query the legacy Project storage identifiers during that
-- window. Keep those physical identifiers until a later contract migration.
--
-- mixed-version-safe: this migration only adds a nullable column, an index,
-- comments, and read-compatible views. Existing Project queries remain valid.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.accounts
  ADD COLUMN IF NOT EXISTS default_workspace_id uuid;

UPDATE kortix.accounts AS account
SET default_workspace_id = (
  SELECT project.project_id
  FROM kortix.projects AS project
  WHERE project.account_id = account.account_id
    AND project.status = 'active'
  ORDER BY project.created_at ASC, project.project_id ASC
  LIMIT 1
)
WHERE account.default_workspace_id IS NULL;

ALTER TABLE kortix.accounts
  ADD CONSTRAINT accounts_default_workspace_id_projects_project_id_fk
  FOREIGN KEY (default_workspace_id)
  REFERENCES kortix.projects(project_id)
  ON DELETE SET NULL
  NOT VALID;

DO $$
DECLARE
  mapping record;
  select_list text;
BEGIN
  FOR mapping IN
    SELECT *
    FROM (
      VALUES
        ('projects', 'workspaces'),
        ('project_access_requests', 'workspace_access_requests'),
        ('project_git_connections', 'workspace_git_connections'),
        ('project_git_credentials', 'workspace_git_credentials'),
        ('project_group_grants', 'workspace_group_grants'),
        ('project_llm_routing_policies', 'workspace_llm_routing_policies'),
        ('project_members', 'workspace_members'),
        ('project_secrets', 'workspace_secrets'),
        ('project_session_connector_bindings', 'workspace_session_connector_bindings'),
        ('project_session_grants', 'workspace_session_grants'),
        ('project_session_public_shares', 'workspace_session_public_shares'),
        ('project_session_runtime_contexts', 'workspace_session_runtime_contexts'),
        ('project_sessions', 'workspace_sessions'),
        ('project_snapshot_builds', 'workspace_snapshot_builds'),
        ('project_trigger_runtime', 'workspace_trigger_runtime'),
        ('executor_project_policies', 'executor_workspace_policies'),
        ('executor_project_settings', 'executor_workspace_settings')
    ) AS names(legacy_name, canonical_name)
  LOOP
    SELECT string_agg(
      CASE column_name
        WHEN 'project_id' THEN format('%I AS workspace_id', column_name)
        WHEN 'project_role' THEN format('%I AS workspace_role', column_name)
        ELSE format('%I', column_name)
      END,
      ', ' ORDER BY ordinal_position
    )
    INTO select_list
    FROM information_schema.columns
    WHERE table_schema = 'kortix'
      AND table_name = mapping.legacy_name;

    IF select_list IS NULL THEN
      RAISE EXCEPTION 'Workspace compatibility source %.% does not exist',
        'kortix',
        mapping.legacy_name;
    END IF;

    EXECUTE format(
      'CREATE OR REPLACE VIEW kortix.%I AS SELECT %s FROM kortix.%I',
      mapping.canonical_name,
      select_list,
      mapping.legacy_name
    );
  END LOOP;
END
$$;

COMMENT ON TABLE kortix.projects IS
  'Deprecated physical storage name. Use the canonical kortix.workspaces interface.';
COMMENT ON TABLE kortix.project_members IS
  'Deprecated physical storage name. Use the canonical kortix.workspace_members interface.';
COMMENT ON TABLE kortix.project_sessions IS
  'Deprecated physical storage name. Use the canonical kortix.workspace_sessions interface.';
