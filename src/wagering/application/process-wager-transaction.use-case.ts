import { WagerTransaction, type CreateWagerTransactionProps } from '../domain/wager-transaction';
import { WagerBalanceEffect } from '../domain/wager-balance-effect';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { WagerTransactionProcessed } from '../domain/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../domain/wager-transaction-pending-reference';
import { DuplicateReversalError, InvalidReferenceKindError } from '../domain/wagering.errors';
import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { InsufficientBalanceError } from '../../wallet/domain/wallet.errors';
import { TransactionRunner } from './ports/unit-of-work';
import { ProcessWagerTransactionCommand } from './process-wager-transaction.command';
import { ProcessWagerTransactionResult } from './process-wager-transaction.result';
import { IdGenerator } from '../../shared/application/id-generator';
import { Clock } from '../../shared/application/clock';
import { EventContext } from '../../shared/domain/event-context';

/** Erros de domínio esperados que a etapa 5 traduz em REJECTED com failureCode.
 *  Qualquer outro erro (bug, timeout, erro de tipo) propaga e provoca rollback —
 *  nunca é silenciosamente maquiado como rejeição de negócio. */
const KNOWN_REJECTION_ERRORS = [InsufficientBalanceError, InvalidReferenceKindError, DuplicateReversalError] as const;

/** Provisório: apenas satisfaz a obrigatoriedade de next_reference_retry_at ao
 *  entrar em PENDING_REFERENCE. NÃO representa a política de backoff (fórmula
 *  exponencial, limite de tentativas/TTL, transição final para REJECTED) —
 *  essa decisão é formal e fica para o incremento do worker de PENDING_REFERENCE
 *  (seção 7.1 do README). */
const INITIAL_REFERENCE_RETRY_DELAY_MS = 30_000;

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

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
      const transaction = WagerTransaction.create(createProps);

      if (cmd.referenceExternalTransactionId) {
        referenceTransaction = await uow.wagerTransaction.findByProviderAndExternalId(
          cmd.providerId,
          cmd.referenceExternalTransactionId,
        );

        if (!referenceTransaction && transaction.requiresReference()) {
          const nextRetryAt = new Date(this.clock.now().getTime() + INITIAL_REFERENCE_RETRY_DELAY_MS);
          transaction.markPendingReference(nextRetryAt);
          await uow.wagerTransaction.save(transaction);
          await uow.outbox.enqueue(this.buildPendingReferenceEvent(transaction, cmd));
          return finish(ProcessWagerTransactionResult.pendingReference(transaction));
        }
      }

      // 4. LOCK NA WALLET — único ponto de leitura no write path
      const wallet = await uow.wallet.findByIdForUpdate(cmd.walletId);

      // 5. REGRA DE NEGÓCIO — decidida por wagering via balanceEffectFor(); Wallet
      //    só sabe debitar/creditar, nunca conhece BET/WIN/LOSS/REFUND/ROLLBACK.
      let ledgerEntry: WalletLedgerEntry | undefined;
      try {
        // Reversão duplicada (seção 7 regra 4) — checada depois do lock e antes
        // de qualquer debit/credit, para nunca mover saldo numa reversão inválida.
        if (referenceTransaction && (cmd.kind === WagerTransactionKind.Refund || cmd.kind === WagerTransactionKind.Rollback)) {
          const alreadyReversed = await uow.wagerTransaction.hasProcessedReversal(referenceTransaction.id, cmd.kind);
          if (alreadyReversed) {
            throw new DuplicateReversalError(referenceTransaction.id, cmd.kind);
          }
        }

        const effect = transaction.balanceEffectFor(referenceTransaction);
        const ledgerEntryId = this.ids.newId();

        if (effect === WagerBalanceEffect.Debit) {
          ledgerEntry = wallet.debit(cmd.money, transaction.id, ledgerEntryId, this.clock.now());
        } else if (effect === WagerBalanceEffect.Credit) {
          ledgerEntry = wallet.credit(cmd.money, transaction.id, ledgerEntryId, this.clock.now());
        }
        // effect === None (LOSS): nenhuma chamada à wallet, nenhum ledger.

        transaction.markProcessed(referenceTransaction?.id, wallet.balance, this.clock.now());
      } catch (err) {
        if (!this.isKnownRejectionError(err)) {
          throw err; // erro inesperado: propaga e provoca rollback da transação inteira
        }
        transaction.reject(err.name, wallet.balance);
      }

      // 6. PERSISTE conforme o outcome
      if (ledgerEntry) {
        await uow.wallet.saveWithLedger(wallet, ledgerEntry);
      }
      await uow.wagerTransaction.save(transaction);

      // 7. OUTBOX — sempre, para qualquer veredito terminal
      await uow.outbox.enqueue(this.buildOutcomeEvent(transaction, cmd));
      if (ledgerEntry) {
        await uow.outbox.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, this.newEventContext(cmd)));
      }

      return finish(ProcessWagerTransactionResult.from(transaction));
    });
  }

  private buildOutcomeEvent(transaction: WagerTransaction, cmd: ProcessWagerTransactionCommand) {
    return transaction.status === WagerTransactionStatus.Rejected
      ? WagerTransactionRejected.from(transaction, this.newEventContext(cmd))
      : WagerTransactionProcessed.from(transaction, this.newEventContext(cmd));
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

  /** Type guard: só os erros de domínio explicitamente listados em
   *  KNOWN_REJECTION_ERRORS viram REJECTED. Qualquer outro erro (bug, timeout,
   *  erro de tipo) deve propagar e provocar rollback — nunca é silenciosamente
   *  maquiado como rejeição de negócio. */
  private isKnownRejectionError(err: unknown): err is Error {
    return KNOWN_REJECTION_ERRORS.some((ErrorClass) => err instanceof ErrorClass);
  }
}
