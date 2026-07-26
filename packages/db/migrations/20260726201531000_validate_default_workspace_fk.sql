-- Validate the additive default-workspace foreign key in a separate
-- transaction. VALIDATE CONSTRAINT does not block normal reads or writes.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.accounts
  VALIDATE CONSTRAINT accounts_default_workspace_id_projects_project_id_fk;
