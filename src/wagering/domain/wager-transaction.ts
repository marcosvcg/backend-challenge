import { Money } from '../../wallet/domain/money';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { WagerBalanceEffect } from './wager-balance-effect';
import { FailureCode } from './failure-code';
import {
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
  UnexpectedReferenceError,
} from './wagering.errors';

const KINDS_REQUIRING_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const KINDS_ALLOWING_OPTIONAL_REFERENCE = new Set([WagerTransactionKind.Win]);

/** ROLLBACK só pode reverter BET, WIN ou REFUND (seção 7 regra 3 do README). */
const VALID_ROLLBACK_REFERENCE_KINDS = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceRetryAttempts: number;
  nextReferenceRetryAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceRetryAttempts: number = 0,
    private _nextReferenceRetryAt?: Date,
  ) {}

  /** Nasce sempre em PENDING. Valida a exigência de referência por kind
   *  (REFUND/ROLLBACK exigem, WIN opcional, demais kinds proíbem — seção 7.1/7.2). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertReferenceRequirement(props.kind, props.referenceExternalTransactionId);

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições (seção 6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceRetryAttempts,
      state.nextReferenceRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceRetryAttempts(): number {
    return this._referenceRetryAttempts;
  }

  get nextReferenceRetryAt(): Date | undefined {
    return this._nextReferenceRetryAt;
  }

  markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextReferenceRetryAt = undefined;
  }

  markPendingReference(nextRetryAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceRetryAttempts += 1;
    this._nextReferenceRetryAt = nextRetryAt;
  }

  reject(code: FailureCode, resultBalance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._nextReferenceRetryAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceRetryAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** false apenas para LOSS — as demais kinds, se processadas, movem saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Efeito no saldo do ponto de vista de wagering (WagerBalanceEffect, não
   *  LedgerDirection — ver wager-balance-effect.ts). ROLLBACK não tem efeito
   *  próprio: inverte o efeito da transação referenciada, por isso `reference`
   *  é obrigatória para ele, e só BET/WIN/REFUND são alvos válidos de reversão. */
  balanceEffectFor(reference?: WagerTransaction): WagerBalanceEffect {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return WagerBalanceEffect.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return WagerBalanceEffect.Credit;
      case WagerTransactionKind.Loss:
        return WagerBalanceEffect.None;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new MissingReferenceError(this.kind);
        }
        if (!VALID_ROLLBACK_REFERENCE_KINDS.has(reference.kind)) {
          throw new InvalidReferenceKindError(reference.kind);
        }
        const referencedEffect = reference.balanceEffectFor();
        return referencedEffect === WagerBalanceEffect.Debit
          ? WagerBalanceEffect.Credit
          : WagerBalanceEffect.Debit;
      }
    }
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attemptedTransition);
    }
  }

  private static assertReferenceRequirement(kind: WagerTransactionKind, referenceExternalTransactionId?: string): void {
    const hasReference = referenceExternalTransactionId !== undefined;
    const required = KINDS_REQUIRING_REFERENCE.has(kind);
    const optional = KINDS_ALLOWING_OPTIONAL_REFERENCE.has(kind);

    if (required && !hasReference) {
      throw new MissingReferenceError(kind);
    }
    if (!required && !optional && hasReference) {
      throw new UnexpectedReferenceError(kind);
    }
  }
}
