import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { createTestOrm, truncateAllTables } from '../../../shared/__test-support__/test-orm';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository';
import { Wallet } from '../../domain/wallet';
import { WalletAlreadyExistsError } from '../../domain/wallet-already-exists.error';
import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';

const AT = new Date('2026-01-01T00:00:00.000Z');

describe('MikroOrmWalletRepository.create — UNIQUE constraint translation (real Postgres)', () => {
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

  it('translates a wallet_player_currency_unique violation into WalletAlreadyExistsError', async () => {
    const playerId = randomUUID();

    await orm.em.fork().transactional(async (em) => {
      const repo = new MikroOrmWalletRepository(em);
      const first = Wallet.open({ id: randomUUID(), playerId, currency: 'BRL', at: AT });
      await repo.create(first);
    });

    await expect(
      orm.em.fork().transactional(async (em) => {
        const repo = new MikroOrmWalletRepository(em);
        const second = Wallet.open({ id: randomUUID(), playerId, currency: 'BRL', at: AT });
        await repo.create(second);
      }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });

  it('does NOT translate a different UNIQUE violation (wallet_pkey, same id) into WalletAlreadyExistsError', async () => {
    const duplicateId = randomUUID();

    await orm.em.fork().transactional(async (em) => {
      const repo = new MikroOrmWalletRepository(em);
      const first = Wallet.open({ id: duplicateId, playerId: randomUUID(), currency: 'BRL', at: AT });
      await repo.create(first);
    });

    let caught: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        const repo = new MikroOrmWalletRepository(em);
        // Same id, but a DIFFERENT playerId — violates wallet_pkey, not
        // wallet_player_currency_unique. Must NOT be reported as WalletAlreadyExistsError.
        const second = Wallet.open({ id: duplicateId, playerId: randomUUID(), currency: 'BRL', at: AT });
        await repo.create(second);
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeInstanceOf(WalletAlreadyExistsError);
    expect(caught).toBeInstanceOf(UniqueConstraintViolationException); // still a real unique violation, just untranslated
  });
});
