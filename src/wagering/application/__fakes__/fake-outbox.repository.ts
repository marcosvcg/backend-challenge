import { IntegrationEvent } from '../../../shared/domain/integration-event';
import { OutboxRepository } from '../../../outbox/application/ports/outbox.repository';

export class FakeOutboxRepository implements OutboxRepository {
  private committed: IntegrationEvent<unknown>[] = [];
  private staged: IntegrationEvent<unknown>[] = [];

  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    this.staged.push(event);
  }

  commit(): void {
    this.committed.push(...this.staged);
    this.staged = [];
  }

  rollback(): void {
    this.staged = [];
  }

  getCommitted(): readonly IntegrationEvent<unknown>[] {
    return this.committed;
  }
}
