import { type Kysely, sql } from 'kysely';

/**
 * Initial schema (PLAN §2.2). Raw SQL on purpose: partial unique indexes, CHECKs and the
 * append-only trigger are the safety net under the domain rules and should read as plain SQL.
 * Every table is keyed by tenant (ADR-017). Money columns are bigint minor units (ADR-002).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE programs (
      tenant_id           text        NOT NULL,
      program_id          text        NOT NULL,
      currency            char(3)     NOT NULL,
      limit_minor         bigint      NOT NULL CHECK (limit_minor >= 0),
      -- no CHECK reserved <= limit: treasury may lower the limit below usage (ADR-013)
      reserved_minor      bigint      NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
      row_version         bigint      NOT NULL DEFAULT 0,
      limit_version       bigint      NOT NULL,
      snapshot_version    bigint      NOT NULL DEFAULT 0,
      last_snapshot_as_of timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, program_id)
    );

    CREATE TABLE reservations (
      id                     uuid        PRIMARY KEY,
      tenant_id              text        NOT NULL,
      program_id             text        NOT NULL,
      invoice_id             text        NOT NULL,
      origin                 text        NOT NULL CHECK (origin IN ('LOCAL', 'EXTERNAL')),
      external_ref           text,
      status                 text        NOT NULL CHECK (status IN ('ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED')),
      invoice_currency       char(3)     NOT NULL,
      invoice_amount_minor   bigint      NOT NULL CHECK (invoice_amount_minor > 0),
      released_invoice_minor bigint      NOT NULL DEFAULT 0,
      program_currency       char(3)     NOT NULL,
      program_amount_minor   bigint      NOT NULL CHECK (program_amount_minor >= 0),
      released_program_minor bigint      NOT NULL DEFAULT 0,
      fx_rate                numeric(30, 12) NOT NULL CHECK (fx_rate > 0),
      fx_source              text        NOT NULL,
      fx_as_of               timestamptz NOT NULL,
      created_at             timestamptz NOT NULL,
      updated_at             timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, program_id),
      CHECK (released_invoice_minor BETWEEN 0 AND invoice_amount_minor),
      CHECK (released_program_minor BETWEEN 0 AND program_amount_minor),
      CHECK ((origin = 'EXTERNAL') = (external_ref IS NOT NULL))
    );
    -- At most one live LOCAL reservation per invoice (ADR-006). Backstop for the domain check.
    CREATE UNIQUE INDEX reservations_live_invoice_uq
      ON reservations (tenant_id, program_id, invoice_id)
      WHERE status <> 'RELEASED' AND origin = 'LOCAL';
    CREATE UNIQUE INDEX reservations_external_ref_uq
      ON reservations (tenant_id, program_id, external_ref)
      WHERE external_ref IS NOT NULL;
    CREATE INDEX reservations_list_idx
      ON reservations (tenant_id, program_id, created_at DESC, id DESC);

    CREATE TABLE ledger_entries (
      id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id            text        NOT NULL,
      program_id           text        NOT NULL,
      reservation_id       uuid        REFERENCES reservations (id),
      type                 text        NOT NULL CHECK (type IN
                             ('RESERVE', 'RELEASE', 'LIMIT_SET', 'EXTERNAL_RESERVE', 'EXTERNAL_RELEASE')),
      reserved_delta_minor bigint      NOT NULL,
      limit_after_minor    bigint      NOT NULL,
      reserved_after_minor bigint      NOT NULL,
      source               text        NOT NULL CHECK (source IN ('HTTP', 'KAFKA', 'SYSTEM')),
      source_ref           text,
      correlation_id       text,
      -- DB time read after the row lock is held: monotone per program (ADR-008, ADR-011)
      occurred_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, program_id)
    );
    CREATE INDEX ledger_program_idx ON ledger_entries (tenant_id, program_id, id);
    CREATE INDEX ledger_reservation_asof_idx ON ledger_entries (reservation_id, occurred_at);

    -- Append-only: the ledger is the audit trail; corrections are new rows, never edits (ADR-008).
    CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ledger_entries is append-only (% rejected)', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;
    CREATE TRIGGER ledger_entries_no_update_delete
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();
    CREATE TRIGGER ledger_entries_no_truncate
      BEFORE TRUNCATE ON ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_immutable();

    CREATE TABLE idempotency_keys (
      tenant_id       text        NOT NULL,
      key             text        NOT NULL,
      operation       text        NOT NULL,
      request_hash    text        NOT NULL,
      response_status integer     NOT NULL,
      response_body   jsonb       NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, key)
    );
    CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

    CREATE TABLE inbox_messages (
      message_id   text        PRIMARY KEY,
      tenant_id    text        NOT NULL,
      program_id   text        NOT NULL,
      type         text        NOT NULL,
      version      bigint      NOT NULL,
      topic        text        NOT NULL,
      partition    integer     NOT NULL,
      "offset"     text        NOT NULL,
      outcome      text        NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE snapshot_parts (
      tenant_id    text        NOT NULL,
      program_id   text        NOT NULL,
      snapshot_id  text        NOT NULL,
      part         integer     NOT NULL CHECK (part >= 1),
      total_parts  integer     NOT NULL CHECK (total_parts >= 1),
      version      bigint      NOT NULL,
      header       jsonb       NOT NULL,
      reservations jsonb       NOT NULL,
      received_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, program_id, snapshot_id, part),
      CHECK (part <= total_parts)
    );
    CREATE INDEX snapshot_parts_received_idx ON snapshot_parts (received_at);

    CREATE TABLE reconciliation_runs (
      id                   uuid        PRIMARY KEY,
      tenant_id            text        NOT NULL,
      program_id           text        NOT NULL,
      snapshot_id          text        NOT NULL,
      version              bigint      NOT NULL,
      as_of                timestamptz NOT NULL,
      treasury_limit_minor bigint      NOT NULL,
      limit_applied        boolean     NOT NULL,
      treasury_total_minor bigint      NOT NULL,
      local_total_minor    bigint      NOT NULL,
      uncertain_count      integer     NOT NULL,
      discrepancy_count    integer     NOT NULL,
      correlation_id       text,
      applied_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, program_id),
      UNIQUE (tenant_id, program_id, version)
    );

    CREATE TABLE reconciliation_discrepancies (
      id                         uuid        PRIMARY KEY,
      first_run_id               uuid        NOT NULL REFERENCES reconciliation_runs (id),
      last_run_id                uuid        NOT NULL REFERENCES reconciliation_runs (id),
      tenant_id                  text        NOT NULL,
      program_id                 text        NOT NULL,
      kind                       text        NOT NULL CHECK (kind IN
                                   ('MISSING_LOCALLY', 'MISSING_IN_TREASURY', 'AMOUNT_MISMATCH')),
      origin                     text        NOT NULL CHECK (origin IN ('LOCAL', 'EXTERNAL')),
      reservation_ref            text        NOT NULL,
      invoice_id                 text        NOT NULL,
      local_outstanding_minor    bigint,
      treasury_outstanding_minor bigint,
      strikes                    integer     NOT NULL DEFAULT 1,
      status                     text        NOT NULL CHECK (status IN ('PENDING', 'OPEN', 'CLEARED')),
      correlation_id             text,
      detected_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, program_id)
    );
    CREATE UNIQUE INDEX discrepancies_live_uq
      ON reconciliation_discrepancies (tenant_id, program_id, kind, origin, reservation_ref)
      WHERE status <> 'CLEARED';
    CREATE INDEX discrepancies_list_idx
      ON reconciliation_discrepancies (tenant_id, program_id, status, detected_at DESC);
  `.execute(db);
}

/** Drops everything created by `up`. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS reconciliation_discrepancies, reconciliation_runs, snapshot_parts,
      inbox_messages, idempotency_keys, ledger_entries, reservations, programs CASCADE;
    DROP FUNCTION IF EXISTS ledger_entries_immutable();
  `.execute(db);
}
