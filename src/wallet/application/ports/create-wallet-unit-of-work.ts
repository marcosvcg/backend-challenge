import { WalletRepository } from './wallet.repository';
import { WagerTransactionRepository } from '../../../wagering/application/ports/wager-transaction.repository';
import { OutboxRepository } from '../../../outbox/application/ports/outbox.repository';
import { TransactionRunner } from '../../../shared/application/transaction-runner';

/** Só o que CreateWalletUseCase realmente usa — sem inbox, que nunca participa
 *  da criação de wallet (não vem de fila). Mesmo mecanismo transacional de
 *  WageringUnitOfWork (em.transactional() por baixo), shape de UoW diferente. */
export interface CreateWalletUnitOfWork {
  wallet: WalletRepository;
  wagerTransaction: WagerTransactionRepository;
  outbox: OutboxRepository;
}

export type CreateWalletTransactionRunner = TransactionRunner<CreateWalletUnitOfWork>;
