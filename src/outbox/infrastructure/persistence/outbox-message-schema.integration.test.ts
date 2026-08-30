import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';

/** Prova, contra Postgres real, que a correção da migration
 *  FixOutboxNextAttemptAtNullable (ARCHITECTURE.md, incremento do Outbox
 *  Publisher) resolveu o conflito entre a coluna NOT NULL original e a CHECK
 *  outbox_next_attempt_coherence: (published_at IS NOT NULL, next_attempt_at
 *  IS NULL) agora é aceito, e (published_at IS NULL, next_attempt_at IS NULL)
 *  continua rejeitado pela CHECK — nunca pela coluna. */
describe('outbox_message schema — next_attempt_at nullable, coherence CHECK still enforced (real Postgres)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
  });

  it('accepts published_at set + next_attempt_at NULL', async () => {
    const id = randomUUID();
    await orm.em.getConnection().execute(
      `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       values ('${id}', '${randomUUID()}', 'TestEvent', '{}'::jsonb, now(), 0, NULL, now())`,
    );

    const rows = await orm.em.getConnection().execute(`select next_attempt_at, published_at from outbox_message where id = '${id}'`);
    expect(rows[0].next_attempt_at).toBeNull();
    expect(rows[0].published_at).not.toBeNull();
  });

  it('rejects both published_at NULL and next_attempt_at NULL (CHECK outbox_next_attempt_coherence)', async () => {
    const id = randomUUID();

    await expect(
      orm.em.getConnection().execute(
        `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
         values ('${id}', '${randomUUID()}', 'TestEvent', '{}'::jsonb, now(), 0, NULL, NULL)`,
      ),
    ).rejects.toThrow(/outbox_next_attempt_coherence/);
  });

  it('rejects both published_at set and next_attempt_at set (mutually exclusive)', async () => {
    const id = randomUUID();

    await expect(
      orm.em.getConnection().execute(
        `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
         values ('${id}', '${randomUUID()}', 'TestEvent', '{}'::jsonb, now(), 0, now(), now())`,
      ),
    ).rejects.toThrow(/outbox_next_attempt_coherence/);
  });
});
