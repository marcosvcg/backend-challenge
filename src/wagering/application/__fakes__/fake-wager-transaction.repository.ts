import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { WagerTransactionRepository } from '../ports/wager-transaction.repository';

export class FakeWagerTransactionRepository implements WagerTransactionRepository {
  private committed = new Map<string, WagerTransaction>();
  private staged = new Map<string, WagerTransaction>();

  seed(transaction: WagerTransaction): void {
    this.committed.set(transaction.id, transaction);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.all().find((tx) => tx.idempotencyKey === idempotencyKey);
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.all().find((tx) => tx.providerId === providerId && tx.externalTransactionId === externalTransactionId);
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    return this.all().some(
      (tx) =>
        tx.referenceTransactionId === referenceTransactionId &&
        tx.kind === kind &&
        tx.status === WagerTransactionStatus.Processed,
    );
  }

  async create(transaction: WagerTransaction): Promise<void> {
    this.staged.set(transaction.id, transaction);
  }

  async update(transaction: WagerTransaction): Promise<void> {
    this.staged.set(transaction.id, transaction);
  }

  commit(): void {
    for (const [id, tx] of this.staged) {
      this.committed.set(id, tx);
    }
    this.staged.clear();
  }

  rollback(): void {
    this.staged.clear();
  }

  getCommitted(id: string): WagerTransaction | undefined {
    return this.committed.get(id);
  }

  private all(): WagerTransaction[] {
    return [...this.committed.values(), ...this.staged.values()];
  }
}
