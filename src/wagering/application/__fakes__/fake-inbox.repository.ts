import { InboxClaimResult, InboxRepository } from '../../../inbox/application/ports/inbox.repository';

interface InboxRow {
  payloadHash: string;
  processedAt?: Date;
}

/** Simula UNIQUE(consumer_name, message_id) + ON CONFLICT DO NOTHING via Map
 *  chaveado por "consumerName:messageId" — tryClaim é atômico dentro do
 *  próprio fake (sem I/O real, mas a semântica de dedupe é fiel). */
export class FakeInboxRepository implements InboxRepository {
  private committed = new Map<string, InboxRow>();
  private staged = new Map<string, InboxRow>();

  async tryClaim(consumerName: string, messageId: string, payloadHash: string): Promise<InboxClaimResult> {
    const key = this.key(consumerName, messageId);
    const existing = this.committed.get(key) ?? this.staged.get(key);
    if (existing) {
      return { isNew: false, payloadHashMatches: existing.payloadHash === payloadHash };
    }
    this.staged.set(key, { payloadHash });
    return { isNew: true, payloadHashMatches: true };
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    const key = this.key(consumerName, messageId);
    const row = this.staged.get(key) ?? this.committed.get(key);
    if (!row) {
      throw new Error(`Inbox row "${key}" was never claimed.`);
    }
    this.staged.set(key, { ...row, processedAt: at });
  }

  commit(): void {
    for (const [key, row] of this.staged) {
      this.committed.set(key, row);
    }
    this.staged.clear();
  }

  rollback(): void {
    this.staged.clear();
  }

  getCommitted(consumerName: string, messageId: string): InboxRow | undefined {
    return this.committed.get(this.key(consumerName, messageId));
  }

  private key(consumerName: string, messageId: string): string {
    return `${consumerName}:${messageId}`;
  }
}
