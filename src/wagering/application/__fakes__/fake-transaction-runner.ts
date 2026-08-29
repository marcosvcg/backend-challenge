import { TransactionRunner, WageringUnitOfWork } from '../ports/unit-of-work';
import { FakeWalletRepository } from './fake-wallet.repository';
import { FakeWagerTransactionRepository } from './fake-wager-transaction.repository';
import { FakeInboxRepository } from './fake-inbox.repository';
import { FakeOutboxRepository } from './fake-outbox.repository';

/** Simula uma transação SQL: `work` opera sobre estado "staged"; se a promise
 *  resolve, todos os 4 repositórios fazem commit juntos; se rejeita, todos
 *  fazem rollback juntos — nunca um commita sem o outro. É isso que permite
 *  provar atomicidade Wallet+Ledger+Inbox+Outbox mesmo sem Postgres real
 *  (ver ARCHITECTURE.md seção 3, "teste obrigatório de prova"). */
export class FakeTransactionRunner implements TransactionRunner {
  constructor(
    public readonly wallet: FakeWalletRepository,
    public readonly wagerTransaction: FakeWagerTransactionRepository,
    public readonly inbox: FakeInboxRepository,
    public readonly outbox: FakeOutboxRepository,
  ) {}

  async run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    const uow: WageringUnitOfWork = {
      wallet: this.wallet,
      wagerTransaction: this.wagerTransaction,
      inbox: this.inbox,
      outbox: this.outbox,
    };

    try {
      const result = await work(uow);
      this.wallet.commit();
      this.wagerTransaction.commit();
      this.inbox.commit();
      this.outbox.commit();
      return result;
    } catch (err) {
      this.wallet.rollback();
      this.wagerTransaction.rollback();
      this.inbox.rollback();
      this.outbox.rollback();
      throw err;
    }
  }
}
