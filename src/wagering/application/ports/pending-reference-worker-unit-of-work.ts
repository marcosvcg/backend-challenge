import { PendingReferenceWorkerRepository } from './pending-reference-worker.repository';
import { WagerTransactionRepository } from './wager-transaction.repository';
import { WalletRepository } from '../../../wallet/application/ports/wallet.repository';
import { OutboxRepository } from '../../../outbox/application/ports/outbox.repository';
import { TransactionRunner } from '../../../shared/application/transaction-runner';

/** Sem inbox — nunca participa deste fluxo (não vem de mensagem de fila). */
export interface PendingReferenceWorkerUnitOfWork {
  pendingReferenceWorker: PendingReferenceWorkerRepository;
  wagerTransaction: WagerTransactionRepository;
  wallet: WalletRepository;
  outbox: OutboxRepository;
}

export type PendingReferenceWorkerTransactionRunner = TransactionRunner<PendingReferenceWorkerUnitOfWork>;
