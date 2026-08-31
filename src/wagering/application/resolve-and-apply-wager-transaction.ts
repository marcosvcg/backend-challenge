import { WagerTransaction } from '../domain/wager-transaction';
import { WagerBalanceEffect } from '../domain/wager-balance-effect';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { WagerTransactionProcessed } from '../domain/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/wager-transaction-rejected';
import {
  DuplicateReversalError,
  IncompatibleReferenceError,
  InvalidReferenceKindError,
} from '../domain/wagering.errors';
import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { InsufficientBalanceError } from '../../wallet/domain/wallet.errors';
import { WalletRepository } from '../../wallet/application/ports/wallet.repository';
import { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { OutboxRepository } from '../../outbox/application/ports/outbox.repository';
import { ProcessWagerTransactionResult } from './process-wager-transaction.result';
import { IdGenerator } from '../../shared/application/id-generator';
import { Clock } from '../../shared/application/clock';
import { EventContext } from '../../shared/domain/event-context';

/** Erros de domínio esperados que este serviço traduz em REJECTED com
 *  failureCode. Qualquer outro erro (bug, timeout, erro de tipo) propaga e
 *  provoca rollback — nunca é silenciosamente maquiado como rejeição de
 *  negócio. Compartilhado entre ProcessWagerTransactionUseCase (referência
 *  resolvida na primeira tentativa) e RetryPendingReferencesUseCase
 *  (referência resolvida depois pelo worker). */
const KNOWN_REJECTION_ERRORS = [
  InsufficientBalanceError,
  InvalidReferenceKindError,
  DuplicateReversalError,
  IncompatibleReferenceError,
] as const;

/** Seção 7 regra 9 do README: saldo insuficiente numa aposta e uma reversão
 *  que produziria saldo negativo são operacionalmente diferentes e precisam
 *  de failureCode distinto, mesmo nascendo do mesmo InsufficientBalanceError
 *  em Wallet.debit() — Wallet nunca sabe o kind da operação (não deve saber),
 *  então a tradução acontece aqui, onde transaction.kind já está disponível. */
const REVERSAL_WOULD_OVERDRAW_FAILURE_CODE = 'ReversalWouldOverdrawError';

export type PersistenceMode = 'create' | 'update';

export interface ResolveAndApplyUnitOfWork {
  wallet: WalletRepository;
  wagerTransaction: WagerTransactionRepository;
  outbox: OutboxRepository;
}

export interface ResolveAndApplyContext {
  transaction: WagerTransaction;
  referenceTransaction?: WagerTransaction;
  /** 'create': a transação ainda não existe no banco (fluxo normal, resolvida
   *  na primeira tentativa). 'update': a transação já existe como
   *  PENDING_REFERENCE (fluxo do worker) — nunca inferido pelo status da
   *  entidade, sempre explícito no call site de cada caller. */
  persistenceMode: PersistenceMode;
  correlationId: string;
  causationId?: string;
}

/** Etapas 4-7 do fluxo fechado em ARCHITECTURE.md seção 13/16: lock da
 *  wallet, validação de compatibilidade da referência, reversão duplicada,
 *  aplicar débito/crédito/nenhum, persistir, outbox. Extraído de
 *  ProcessWagerTransactionUseCase para ser reusado, sem duplicação de regra,
 *  pelo worker de PENDING_REFERENCE — a única diferença entre os dois
 *  callers é COMO a referência chegou resolvida (na hora vs. depois) e se a
 *  WagerTransaction precisa de create() ou update() ao final. */
export class ResolveAndApplyWagerTransaction {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(ctx: ResolveAndApplyContext, uow: ResolveAndApplyUnitOfWork): Promise<ProcessWagerTransactionResult> {
    const { transaction, referenceTransaction } = ctx;

    // LOCK NA WALLET — único ponto de leitura no write path
    const wallet = await uow.wallet.findByIdForUpdate(transaction.walletId);

    // REGRA DE NEGÓCIO — decidida por wagering via balanceEffectFor(); Wallet
    // só sabe debitar/creditar, nunca conhece BET/WIN/LOSS/REFUND/ROLLBACK.
    let ledgerEntry: WalletLedgerEntry | undefined;
    try {
      // Compatibilidade da referência (seção 7 regras 2, 3, 5) — checada antes
      // de qualquer movimento de saldo.
      if (referenceTransaction) {
        transaction.assertCompatibleReference(referenceTransaction);
      }

      // Reversão duplicada (seção 7 regra 4) — checada depois do lock e antes
      // de qualquer debit/credit, para nunca mover saldo numa reversão inválida.
      if (
        referenceTransaction &&
        (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback)
      ) {
        const alreadyReversed = await uow.wagerTransaction.hasProcessedReversal(
          referenceTransaction.id,
          transaction.kind,
        );
        if (alreadyReversed) {
          throw new DuplicateReversalError(referenceTransaction.id, transaction.kind);
        }
      }

      const effect = transaction.balanceEffectFor(referenceTransaction);
      const ledgerEntryId = this.ids.newId();

      if (effect === WagerBalanceEffect.Debit) {
        ledgerEntry = wallet.debit(transaction.money, transaction.id, ledgerEntryId, this.clock.now());
      } else if (effect === WagerBalanceEffect.Credit) {
        ledgerEntry = wallet.credit(transaction.money, transaction.id, ledgerEntryId, this.clock.now());
      }
      // effect === None (LOSS): nenhuma chamada à wallet, nenhum ledger.

      transaction.markProcessed(referenceTransaction?.id, wallet.balance, this.clock.now());
    } catch (err) {
      if (!this.isKnownRejectionError(err)) {
        throw err; // erro inesperado: propaga e provoca rollback da transação inteira
      }
      transaction.reject(this.failureCodeFor(err, transaction), wallet.balance);
    }

    // PERSISTE conforme o outcome — wager_transaction PRIMEIRO: o ledger entry
    // tem FK para wager_transaction.id (ARCHITECTURE.md seção 8).
    if (ctx.persistenceMode === 'create') {
      await uow.wagerTransaction.create(transaction);
    } else {
      await uow.wagerTransaction.update(transaction);
    }
    if (ledgerEntry) {
      await uow.wallet.saveWithLedger(wallet, ledgerEntry);
    }

    // OUTBOX — sempre, para qualquer veredito terminal
    await uow.outbox.enqueue(this.buildOutcomeEvent(transaction, ctx));
    if (ledgerEntry) {
      await uow.outbox.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, this.newEventContext(ctx)));
    }

    return ProcessWagerTransactionResult.from(transaction);
  }

  private buildOutcomeEvent(transaction: WagerTransaction, ctx: ResolveAndApplyContext) {
    return transaction.status === WagerTransactionStatus.Rejected
      ? WagerTransactionRejected.from(transaction, this.newEventContext(ctx))
      : WagerTransactionProcessed.from(transaction, this.newEventContext(ctx));
  }

  private newEventContext(ctx: ResolveAndApplyContext): EventContext {
    return {
      eventId: this.ids.newId(),
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
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

  /** InsufficientBalanceError vem de Wallet.debit() tanto para um BET quanto
   *  para um ROLLBACK cujo efeito invertido é um débito — Wallet não distingue
   *  os dois casos, e não deve. A distinção de failureCode é responsabilidade
   *  de wagering, que já sabe o kind da transação neste ponto. */
  private failureCodeFor(err: Error, transaction: WagerTransaction): string {
    if (err instanceof InsufficientBalanceError && transaction.kind === WagerTransactionKind.Rollback) {
      return REVERSAL_WOULD_OVERDRAW_FAILURE_CODE;
    }
    return err.name;
  }
}
