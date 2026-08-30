import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { MikroOrmInboxRepository } from './mikro-orm-inbox.repository';
import { InboxMessageRow } from './inbox-message.row';

describe('MikroOrmInboxRepository — integration (real Postgres)', () => {
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

  it('tryClaim inserts a new row and returns isNew=true', async () => {
    await orm.em.transactional(async (em) => {
      const repo = new MikroOrmInboxRepository(em);
      const result = await repo.tryClaim('consumer-a', 'msg-1', 'hash-1');
      expect(result).toEqual({ isNew: true, payloadHashMatches: true });
    });
  });

  it('tryClaim on an already-claimed (consumerName, messageId) with the SAME payload returns isNew=false, payloadHashMatches=true', async () => {
    await orm.em.transactional(async (em) => {
      const repo = new MikroOrmInboxRepository(em);
      await repo.tryClaim('consumer-a', 'msg-1', 'hash-1');
    });

    await orm.em.transactional(async (em) => {
      const repo = new MikroOrmInboxRepository(em);
      const result = await repo.tryClaim('consumer-a', 'msg-1', 'hash-1');
      expect(result).toEqual({ isNew: false, payloadHashMatches: true });
    });
  });

  it('tryClaim on an already-claimed (consumerName, messageId) with a DIFFERENT payload returns isNew=false, payloadHashMatches=false', async () => {
    await orm.em.transactional(async (em) => {
      const repo = new MikroOrmInboxRepository(em);
      await repo.tryClaim('consumer-a', 'msg-1', 'hash-A');
    });

    await orm.em.transactional(async (em) => {
      const repo = new MikroOrmInboxRepository(em);
      const result = await repo.tryClaim('consumer-a', 'msg-1', 'hash-B');
      expect(result).toEqual({ isNew: false, payloadHashMatches: false });
    });
  });

  it('markProcessed sets processedAt on the claimed row', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');

    await orm.em.transactional(async (em) => {
      const repo = new MikroOrmInboxRepository(em);
      await repo.tryClaim('consumer-a', 'msg-1', 'hash-1');
      await repo.markProcessed('consumer-a', 'msg-1', at);
    });

    const row = await orm.em.fork().findOneOrFail(InboxMessageRow, {
      consumerName: 'consumer-a',
      messageId: 'msg-1',
    });
    expect(row.processedAt).toEqual(at);
  });

  it('50 concurrent tryClaim calls for the SAME (consumerName, messageId): exactly ONE gets isNew=true', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 50 }, () =>
        orm.em.fork().transactional(async (em) => {
          const repo = new MikroOrmInboxRepository(em);
          return repo.tryClaim('consumer-concurrent', 'msg-concurrent', 'hash-1');
        }),
      ),
    );

    const newClaims = attempts.filter((r) => r.isNew);
    expect(newClaims.length).toBe(1); // proves ON CONFLICT DO NOTHING under real concurrency, not just sequential calls
  });
});
