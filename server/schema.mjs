// Additive, version-controlled migration. Applied only after owner authentication.
export const migration = `
CREATE SCHEMA IF NOT EXISTS trading_journal;
CREATE TABLE IF NOT EXISTS trading_journal.revisions (
  owner_id text NOT NULL,
  entity text NOT NULL CHECK (entity IN ('accounts','trades','legs','actions','quotes','lists','settings','history')),
  record_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  change_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (owner_id, entity, record_id, revision)
);
CREATE TABLE IF NOT EXISTS trading_journal.commits (
  owner_id text NOT NULL,
  transaction_id uuid NOT NULL,
  body_hash text NOT NULL,
  PRIMARY KEY (owner_id, transaction_id)
);
`;
