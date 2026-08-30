import { Migration } from '@mikro-orm/migrations';

/** ARCHITECTURE.md seção 8 — tabela `wallet_ledger_entry`, imutável via trigger. */
export class Migration20260829224325_CreateWalletLedgerEntry extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table "wallet_ledger_entry" (
        "id"              uuid not null,
        "wallet_id"       uuid not null,
        "transaction_id"  uuid not null,
        "direction"       varchar(6) not null,
        "amount"          numeric(19,2) not null,
        "currency"        varchar(3) not null,
        "balance_before"  numeric(19,2) not null,
        "balance_after"   numeric(19,2) not null,
        "created_at"      timestamptz not null default now(),

        constraint "wallet_ledger_entry_pkey" primary key ("id"),

        constraint "wallet_ledger_entry_wallet_fk"
          foreign key ("wallet_id") references "wallet" ("id"),
        constraint "wallet_ledger_entry_transaction_fk"
          foreign key ("transaction_id") references "wager_transaction" ("id"),

        constraint "ledger_direction_valid" check ("direction" in ('DEBIT','CREDIT')),
        constraint "ledger_amount_positive" check ("amount" > 0),
        constraint "ledger_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "ledger_balance_before_nonneg" check ("balance_before" >= 0),
        constraint "ledger_balance_after_nonneg" check ("balance_after" >= 0),

        constraint "ledger_balance_arithmetic" check (
          ("direction" = 'DEBIT'  and "balance_after" = "balance_before" - "amount")
          or ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
        ),

        constraint "ledger_transaction_wallet_unique" unique ("transaction_id", "wallet_id")
      );

      create index "ledger_wallet_id_created_at_id_idx"
        on "wallet_ledger_entry" ("wallet_id", "created_at", "id");

      create function "reject_ledger_mutation"() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entry is immutable: % not allowed', TG_OP;
      end;
      $$ language plpgsql;

      create trigger "wallet_ledger_entry_no_update"
        before update on "wallet_ledger_entry"
        for each row execute function "reject_ledger_mutation"();

      create trigger "wallet_ledger_entry_no_delete"
        before delete on "wallet_ledger_entry"
        for each row execute function "reject_ledger_mutation"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists "wallet_ledger_entry_no_delete" on "wallet_ledger_entry";
      drop trigger if exists "wallet_ledger_entry_no_update" on "wallet_ledger_entry";
      drop function if exists "reject_ledger_mutation"();
      drop table if exists "wallet_ledger_entry" cascade;
    `);
  }

}
