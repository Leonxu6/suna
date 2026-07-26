// Create the default-workspace lookup index without blocking account writes.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_accounts_default_workspace
      on kortix.accounts (default_workspace_id)
  `);
};

export const down = false;
