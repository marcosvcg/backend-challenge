import { Migration } from '@mikro-orm/migrations';

/** ARCHITECTURE.md seção 10 — tabela `inbox_message`. */
export class Migration20260829224330_CreateInboxMessage extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table "inbox_message" (
        "consumer_name"  varchar(64) not null,
        "message_id"     varchar(191) not null,
        "payload_hash"   varchar(64) not null,
        "received_at"    timestamptz not null default now(),
        "processed_at"   timestamptz,

        constraint "inbox_message_pkey" primary key ("consumer_name", "message_id")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "inbox_message" cascade;`);
  }

}
