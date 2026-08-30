import { Migration } from '@mikro-orm/migrations';

/** ARCHITECTURE.md seção 9 — tabela `wager_transaction`. */
export class Migration20260829224320_CreateWagerTransaction extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table "wager_transaction" (
        "id"                                 uuid not null,
        "provider_id"                        varchar(64) not null,
        "external_transaction_id"            varchar(128) not null,
        "idempotency_key"                    varchar(191) not null,
        "payload_hash"                       varchar(64) not null,
        "wallet_id"                          uuid not null,
        "player_id"                          uuid not null,
        "round_id"                           varchar(128) not null,
        "game_id"                            varchar(128) not null,
        "kind"                               varchar(16) not null,
        "amount"                             numeric(19,2) not null,
        "currency"                           varchar(3) not null,

        "reference_external_transaction_id"  varchar(128),
        "reference_transaction_id"           uuid,

        "status"                             varchar(20) not null,
        "failure_code"                       varchar(64),
        "processed_at"                       timestamptz,

        "result_balance_amount"              numeric(19,2),
        "result_balance_currency"            varchar(3),

        "reference_retry_attempts"           integer not null default 0,
        "next_reference_retry_at"            timestamptz,

        "created_at"                         timestamptz not null default now(),

        constraint "wager_transaction_pkey" primary key ("id"),

        constraint "wager_transaction_wallet_fk"
          foreign key ("wallet_id") references "wallet" ("id"),
        constraint "wager_transaction_reference_fk"
          foreign key ("reference_transaction_id") references "wager_transaction" ("id"),

        constraint "wt_kind_valid"
          check ("kind" in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint "wt_status_valid"
          check ("status" in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),

        constraint "wt_amount_positive" check ("amount" > 0),
        constraint "wt_currency_format" check ("currency" ~ '^[A-Z]{3}$'),

        constraint "wt_reference_required_by_kind" check (
          ("kind" in ('REFUND','ROLLBACK') and "reference_external_transaction_id" is not null)
          or ("kind" = 'WIN')
          or ("kind" in ('BET','LOSS','OPENING') and "reference_external_transaction_id" is null)
        ),

        constraint "wt_reference_transaction_only_when_applicable" check (
          "reference_transaction_id" is null or "kind" in ('REFUND','ROLLBACK','WIN')
        ),

        constraint "wt_pending_reference_only_when_unresolved" check (
          ("status" = 'PENDING_REFERENCE' and "kind" in ('REFUND','ROLLBACK') and "reference_transaction_id" is null)
          or ("status" <> 'PENDING_REFERENCE')
        ),

        constraint "wt_opening_always_processed" check (
          "kind" <> 'OPENING' or "status" = 'PROCESSED'
        ),

        constraint "wt_processed_at_only_when_processed" check (
          ("status" = 'PROCESSED' and "processed_at" is not null)
          or ("status" <> 'PROCESSED' and "processed_at" is null)
        ),

        constraint "wt_failure_code_coherence" check (
          ("status" in ('REJECTED','FAILED') and "failure_code" is not null)
          or ("status" not in ('REJECTED','FAILED') and "failure_code" is null)
        ),

        constraint "wt_result_balance_currency_format" check (
          "result_balance_currency" is null or "result_balance_currency" ~ '^[A-Z]{3}$'
        ),
        constraint "wt_result_balance_coherence" check (
          ("status" in ('PENDING','PENDING_REFERENCE','FAILED') and "result_balance_amount" is null and "result_balance_currency" is null)
          or ("status" in ('PROCESSED','REJECTED') and "result_balance_amount" is not null and "result_balance_currency" is not null)
        ),

        constraint "wt_reference_retry_attempts_nonneg" check ("reference_retry_attempts" >= 0),
        constraint "wt_next_retry_coherence" check (
          ("status" = 'PENDING_REFERENCE' and "next_reference_retry_at" is not null)
          or ("status" <> 'PENDING_REFERENCE' and "next_reference_retry_at" is null)
        ),

        constraint "wt_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wt_provider_external_unique" unique ("provider_id", "external_transaction_id")
      );

      create unique index "wt_reference_reversal_unique"
        on "wager_transaction" ("reference_transaction_id", "kind")
        where "status" = 'PROCESSED' and "kind" in ('REFUND','ROLLBACK');

      create index "wt_pending_reference_worker_idx"
        on "wager_transaction" ("next_reference_retry_at")
        where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wager_transaction" cascade;`);
  }

}
