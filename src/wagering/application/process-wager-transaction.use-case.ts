import { WagerTransaction, type CreateWagerTransactionProps } from '../domain/wager-transaction';
import { WagerTransactionPendingReference } from '../domain/wager-transaction-pending-reference';
import { WageringTransactionRunner } from './ports/unit-of-work';
import { ProcessWagerTransactionCommand } from './process-wager-transaction.command';
import { ProcessWagerTransactionResult } from './process-wager-transaction.result';
import { ResolveAndApplyWagerTransaction } from './resolve-and-apply-wager-transaction';
import { ReferenceRetryPolicy, nextReferenceRetryDelayMs } from './reference-retry-policy';
import { IdGenerator } from '../../shared/application/id-generator';
import { Clock } from '../../shared/application/clock';
import { EventContext } from '../../shared/domain/event-context';

export class ProcessWagerTransactionUseCase {
  private readonly resolveAndApply: ResolveAndApplyWagerTransaction;

  constructor(
    private readonly runner: WageringTransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    /** Mesma política usada pelo worker de PENDING_REFERENCE
     *  (RetryPendingReferencesUseCase) — fonte única de verdade para o
     *  cálculo de backoff. O primeiro agendamento (aqui) usa
     *  nextReferenceRetryDelayMs(policy, 1); os seguintes (worker) usam
     *  attemptNumber crescente. referenceRetryAttempts representa o número
     *  TOTAL de tentativas de resolução já realizadas, incluindo esta
     *  primeira — não um contador de retries adicionais além dela. */
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {
    this.resolveAndApply = new ResolveAndApplyWagerTransaction(ids, clock);
  }

  async execute(cmd: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    return this.runner.run(async (uow) => {
      let inboxClaimed = false;

      const finish = async (result: ProcessWagerTransactionResult): Promise<ProcessWagerTransactionResult> => {
        if (inboxClaimed && cmd.consumerName && cmd.messageId) {
          await uow.inbox.markProcessed(cmd.consumerName, cmd.messageId, this.clock.now());
        }
        return result;
      };

      // 1. INBOX — só quando origin === 'queue'
      if (cmd.origin === 'queue' && cmd.consumerName && cmd.messageId) {
        const claim = await uow.inbox.tryClaim(cmd.consumerName, cmd.messageId, cmd.payloadHash);
        if (!claim.isNew) {
          if (claim.payloadHashMatches) {
            return finish(ProcessWagerTransactionResult.alreadyAcked());
          }
          return finish(ProcessWagerTransactionResult.permanentError('INBOX_PAYLOAD_MISMATCH'));
        }
        inboxClaimed = true;
      }

      // 2. IDEMPOTÊNCIA (idempotencyKey) — vale para HTTP e SQS igualmente
      const existing = await uow.wagerTransaction.findByIdempotencyKey(cmd.idempotencyKey);
      if (existing) {
        if (!existing.matchesPayload(cmd.payloadHash)) {
          return finish(ProcessWagerTransactionResult.idempotencyConflict(cmd.idempotencyKey));
        }
        return finish(ProcessWagerTransactionResult.replay(existing));
      }

      // 3. RESOLVER REFERÊNCIA (REFUND/ROLLBACK obrigatório; WIN opcional)
      let referenceTransaction: WagerTransaction | undefined;
      const createProps: CreateWagerTransactionProps = {
        id: this.ids.newId(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash: cmd.payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money: cmd.money,
        createdAt: this.clock.now(),
        ...(cmd.referenceExternalTransactionId !== undefined
          ? { referenceExternalTransactionId: cmd.referenceExternalTransactionId }
          : {}),
      };
      // WagerTransaction.create() (acima) já aplicou assertReferenceRequirement
      // — qualquer referenceExternalTransactionId que chegou até aqui definido
      // já passou pela invariante de domínio (string, trim().length > 0).
      // Checagem por `!== undefined`, nunca truthiness: antes desta correção,
      // `if (cmd.referenceExternalTransactionId)` tratava '' como ausente
      // (falsy), divergindo de WagerTransaction.create() (que tratava '' como
      // presente) — um REFUND com referência '' passava create() mas nunca
      // tinha a referência resolvida aqui, aplicando o efeito de saldo sem
      // validação (hardening SQS). Agora as duas checagens concordam sempre.
      const transaction = WagerTransaction.create(createProps);

      if (cmd.referenceExternalTransactionId !== undefined) {
        referenceTransaction = await uow.wagerTransaction.findByProviderAndExternalId(
          cmd.providerId,
          cmd.referenceExternalTransactionId,
        );

        if (!referenceTransaction && transaction.requiresReference()) {
          const delayMs = nextReferenceRetryDelayMs(this.retryPolicy, 1); // 1ª tentativa
          const nextRetryAt = new Date(this.clock.now().getTime() + delayMs);
          transaction.markPendingReference(nextRetryAt);
          await uow.wagerTransaction.create(transaction);
          await uow.outbox.enqueue(this.buildPendingReferenceEvent(transaction, cmd));
          return finish(ProcessWagerTransactionResult.pendingReference(transaction));
        }
      }

      // 4-7. Lock da wallet, validação de compatibilidade, aplicar, persistir,
      // outbox — compartilhado com o worker de PENDING_REFERENCE (nunca
      // duplicado). create(): esta é a primeira persistência desta transação
      // neste fluxo — o único caminho que já a teria persistido
      // (PENDING_REFERENCE, acima) já retornou antes de chegar aqui.
      const result = await this.resolveAndApply.execute(
        {
          transaction,
          persistenceMode: 'create',
          correlationId: cmd.correlationId,
          ...(referenceTransaction !== undefined ? { referenceTransaction } : {}),
          ...(cmd.causationId !== undefined ? { causationId: cmd.causationId } : {}),
        },
        uow,
      );

      return finish(result);
    });
  }

  private buildPendingReferenceEvent(transaction: WagerTransaction, cmd: ProcessWagerTransactionCommand) {
    return WagerTransactionPendingReference.from(transaction, this.newEventContext(cmd));
  }

  private newEventContext(cmd: ProcessWagerTransactionCommand): EventContext {
    return {
      eventId: this.ids.newId(),
      correlationId: cmd.correlationId,
      ...(cmd.causationId !== undefined ? { causationId: cmd.causationId } : {}),
      occurredAt: this.clock.now(),
    };
  }
}
