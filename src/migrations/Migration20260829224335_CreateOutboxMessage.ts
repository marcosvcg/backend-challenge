import { Migration } from '@mikro-orm/migrations';

/** ARCHITECTURE.md seção 11 — tabela `outbox_message`. */
export class Migration20260829224335_CreateOutboxMessage extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table "outbox_message" (
        "id"               uuid not null,
        "aggregate_id"     uuid not null,
        "event_type"       varchar(64) not null,
        "payload"          jsonb not null,
        "occurred_at"      timestamptz not null,

        "attempts"         integer not null default 0,
        "next_attempt_at"  timestamptz not null default now(),
        "published_at"     timestamptz,

        constraint "outbox_message_pkey" primary key ("id"),
        constraint "outbox_attempts_nonneg" check ("attempts" >= 0),

        constraint "outbox_next_attempt_coherence" check (
          ("published_at" is null and "next_attempt_at" is not null)
          or ("published_at" is not null and "next_attempt_at" is null)
        )
      );

      create index "outbox_pending_claim_idx"
        on "outbox_message" ("next_attempt_at")
        where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "outbox_message" cascade;`);
  }

}
