import { OutboxPublisherRepository } from './outbox-publisher.repository';
import { TransactionRunner } from '../../../shared/application/transaction-runner';

export interface OutboxPublisherUnitOfWork {
  outboxPublisher: OutboxPublisherRepository;
}

export type OutboxPublisherTransactionRunner = TransactionRunner<OutboxPublisherUnitOfWork>;
