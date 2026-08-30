import { Migration } from '@mikro-orm/migrations';

/** ARCHITECTURE.md seção 7 — tabela `wallet`. */
export class Migration20260829224310_CreateWallet extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table "wallet" (
        "id"             uuid not null,
        "player_id"      uuid not null,
        "currency"       varchar(3) not null,
        "balance_amount" numeric(19,2) not null,
        "version"        integer not null default 1,
        "created_at"     timestamptz not null default now(),
        "updated_at"     timestamptz not null default now(),

        constraint "wallet_pkey" primary key ("id"),
        constraint "wallet_balance_nonneg" check ("balance_amount" >= 0),
        constraint "wallet_version_positive" check ("version" >= 1),
        constraint "wallet_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_player_currency_unique" unique ("player_id", "currency")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wallet" cascade;`);
  }

}
