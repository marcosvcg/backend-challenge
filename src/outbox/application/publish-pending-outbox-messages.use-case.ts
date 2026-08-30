import { OutboxPublisherTransactionRunner } from './ports/outbox-publisher-unit-of-work';
import { SqsPublisher } from './ports/sqs-publisher';
import { Clock } from '../../shared/application/clock';

/** Backoff provisório — mesmo espírito do INITIAL_REFERENCE_RETRY_DELAY_MS em
 *  ProcessWagerTransactionUseCase: satisfaz a obrigatoriedade de
 *  next_attempt_at, não representa uma política formal de backoff
 *  exponencial (isso fica para quando justificarmos formalmente essa decisão). */
const RETRY_DELAY_MS = 10_000;

export interface PublishPendingOutboxMessagesResult {
  claimed: number;
  published: number;
  failed: number;
}

export class PublishPendingOutboxMessagesUseCase {
  constructor(
    private readonly runner: OutboxPublisherTransactionRunner,
    private readonly sqs: SqsPublisher,
    private readonly clock: Clock,
    private readonly batchSize: number = 10,
  ) {}

  async execute(): Promise<PublishPendingOutboxMessagesResult> {
    return this.runner.run(async (uow) => {
      // FOR UPDATE SKIP LOCKED: as linhas devolvidas aqui permanecem travadas
      // até este runner.run() commitar — é essa transação em aberto, não
      // nenhum lease/ownership, que impede outro publisher concorrente de
      // reivindicar as mesmas linhas (ARCHITECTURE.md seção 11).
      const batch = await uow.outboxPublisher.claimBatch(this.batchSize);

      let published = 0;
      let failed = 0;

      // A transação PERMANECE ABERTA durante todo este loop, incluindo os
      // awaits de I/O de rede ao SQS — trade-off assumido conscientemente
      // (ARCHITECTURE.md seção 11): é exatamente isso que preserva a exclusão
      // entre publishers sem precisar de lease/worker ownership.
      for (const message of batch) {
        // O catch cobre EXCLUSIVAMENTE a chamada de rede ao SQS — nunca
        // markPublished(). Se o envio falhar de verdade, agendamos retry:
        // a mensagem nunca chegou ao SQS, então reenviar é seguro e correto.
        // Se markPublished() falhar DEPOIS de o envio já ter tido sucesso,
        // esse erro deve propagar e provocar rollback da transação inteira —
        // nunca chamamos scheduleRetry() nesse caso, porque isso reagendaria
        // uma mensagem que JÁ foi entregue ao SQS. O resultado correto desse
        // cenário é: a linha permanece pendente (rollback desfaz nada, pois
        // nada chegou a commitar) e será reclamada de novo no próximo ciclo —
        // reenviando ao SQS uma mensagem que já tinha sido enviada. Isso é
        // exatamente a semântica at-least-once (nunca exactly-once) descrita
        // em ARCHITECTURE.md seção 11: a duplicação é aceita, e cabe ao
        // consumidor deduplicar por eventId.
        let sent = false;
        try {
          await this.sqs.publish(message.envelope, message.aggregateId);
          sent = true;
        } catch {
          // Falha isolada nesta linha não aborta o batch inteiro — as demais
          // linhas continuam sendo processadas e, ao final, tudo commita
          // junto (inclusive o scheduleRetry desta linha).
          const nextAttemptAt = new Date(this.clock.now().getTime() + RETRY_DELAY_MS);
          await uow.outboxPublisher.scheduleRetry(message.id, nextAttemptAt);
          failed += 1;
        }

        if (sent) {
          await uow.outboxPublisher.markPublished(message.id, this.clock.now());
          published += 1;
        }
      }

      return { claimed: batch.length, published, failed };
    });
  }
}
