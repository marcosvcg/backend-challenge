import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionPendingReference } from '../domain/wager-transaction-pending-reference';
import { WagerTransactionRejected } from '../domain/wager-transaction-rejected';
import { PendingReferenceWorkerTransactionRunner } from './ports/pending-reference-worker-unit-of-work';
import { ResolveAndApplyWagerTransaction } from './resolve-and-apply-wager-transaction';
import { ReferenceRetryPolicy, nextReferenceRetryDelayMs } from './reference-retry-policy';
import { IdGenerator } from '../../shared/application/id-generator';
import { Clock } from '../../shared/application/clock';
import { EventContext } from '../../shared/domain/event-context';

const REFERENCE_NOT_FOUND_FAILURE_CODE = 'REFERENCE_NOT_FOUND';

export interface RetryPendingReferencesResult {
  claimed: number;
  resolved: number;
  rescheduled: number;
  rejected: number;
}

/** Worker de recuperação para REFUND/ROLLBACK que chegam antes da transação
 *  referenciada (README seção 7.1). Reusa ResolveAndApplyWagerTransaction —
 *  a mesma regra financeira do fluxo normal, nunca duplicada — com
 *  persistenceMode: 'update', já que a WagerTransaction já existe como
 *  PENDING_REFERENCE. Claim via FOR UPDATE SKIP LOCKED garante que duas
 *  instâncias do worker nunca processam a mesma pendência simultaneamente,
 *  sem lock global nem estado em memória (ARCHITECTURE.md seção 18/22). */
export class RetryPendingReferencesUseCase {
  private readonly resolveAndApply: ResolveAndApplyWagerTransaction;

  constructor(
    private readonly runner: PendingReferenceWorkerTransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly batchSize: number = 10,
  ) {
    this.resolveAndApply = new ResolveAndApplyWagerTransaction(ids, clock);
  }

  async execute(): Promise<RetryPendingReferencesResult> {
    return this.runner.run(async (uow) => {
      const now = this.clock.now();
      // FOR UPDATE SKIP LOCKED: as linhas devolvidas aqui permanecem travadas
      // até este runner.run() commitar — a mesma disciplina do Outbox
      // Publisher (seção 18), aplicada aqui à resolução de referências.
      const batch = await uow.pendingReferenceWorker.claimBatch(this.batchSize, now);

      let resolved = 0;
      let rescheduled = 0;
      let rejected = 0;

      for (const transaction of batch) {
        const outcome = await this.processOne(transaction, uow);
        if (outcome === 'resolved') resolved += 1;
        else if (outcome === 'rescheduled') rescheduled += 1;
        else rejected += 1;
      }

      return { claimed: batch.length, resolved, rescheduled, rejected };
    });
  }

  private async processOne(
    transaction: WagerTransaction,
    uow: Parameters<Parameters<PendingReferenceWorkerTransactionRunner['run']>[0]>[0],
  ): Promise<'resolved' | 'rescheduled' | 'rejected'> {
    if (!transaction.referenceExternalTransactionId) {
      // Nunca deveria acontecer (claimBatch só devolve PENDING_REFERENCE, que
      // exige referenceExternalTransactionId) — erro inesperado, propaga.
      throw new Error(`PENDING_REFERENCE transaction "${transaction.id}" has no referenceExternalTransactionId.`);
    }

    const referenceTransaction = await uow.wagerTransaction.findByProviderAndExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );

    if (referenceTransaction) {
      // Reusa a MESMA regra financeira do fluxo normal — validação de
      // compatibilidade, reversão duplicada, lock da wallet, ledger, outbox —
      // nunca duplicada aqui. persistenceMode: 'update' porque a transação já
      // existe como PENDING_REFERENCE.
      await this.resolveAndApply.execute(
        {
          transaction,
          referenceTransaction,
          persistenceMode: 'update',
          correlationId: transaction.id,
        },
        uow,
      );
      return 'resolved';
    }

    const nextAttemptNumber = transaction.referenceRetryAttempts + 1;
    if (nextAttemptNumber <= this.retryPolicy.maxAttempts) {
      const delayMs = nextReferenceRetryDelayMs(this.retryPolicy, nextAttemptNumber);
      const nextRetryAt = new Date(this.clock.now().getTime() + delayMs);
      transaction.markPendingReference(nextRetryAt);
      await uow.wagerTransaction.update(transaction);
      await uow.outbox.enqueue(WagerTransactionPendingReference.from(transaction, this.newEventContext(transaction)));
      return 'rescheduled';
    }

    // Limite de tentativas esgotado — REJECTED com failureCode explícito.
    // Lock da wallet só aqui (nunca no reschedule acima): resultBalance deve
    // ser o saldo REAL observado no momento do veredito (mesma semântica do
    // resto do código), nunca transaction.money (que é só o valor da
    // operação em si, ex.: R$30 do REFUND). reject() já limpa
    // next_reference_retry_at (ver WagerTransaction.reject).
    const wallet = await uow.wallet.findByIdForUpdate(transaction.walletId);
    transaction.reject(REFERENCE_NOT_FOUND_FAILURE_CODE, wallet.balance);
    await uow.wagerTransaction.update(transaction);
    await uow.outbox.enqueue(WagerTransactionRejected.from(transaction, this.newEventContext(transaction)));
    return 'rejected';
  }

  private newEventContext(transaction: WagerTransaction): EventContext {
    return {
      eventId: this.ids.newId(),
      correlationId: transaction.id,
      occurredAt: this.clock.now(),
    };
  }
}
