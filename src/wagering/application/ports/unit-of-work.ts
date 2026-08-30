import { WalletRepository } from '../../../wallet/application/ports/wallet.repository';
import { WagerTransactionRepository } from './wager-transaction.repository';
import { InboxRepository } from '../../../inbox/application/ports/inbox.repository';
import { OutboxRepository } from '../../../outbox/application/ports/outbox.repository';
import { TransactionRunner } from '../../../shared/application/transaction-runner';

export interface WageringUnitOfWork {
  wallet: WalletRepository;
  wagerTransaction: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/** Abre uma transação SQL, instancia os repositórios amarrados a ela, executa
 *  `work`, e faz commit/rollback conforme a promise resolve ou rejeita. Os
 *  repositórios só existem dentro desta chamada — não há caminho para obtê-los
 *  fora de uma transação (ARCHITECTURE.md seção 3). */
export type WageringTransactionRunner = TransactionRunner<WageringUnitOfWork>;
