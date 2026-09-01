import { Money } from '../../wallet/domain/money';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { WagerBalanceEffect } from './wager-balance-effect';
import { FailureCode } from './failure-code';
import {
  IncompatibleReferenceError,
  InvalidReferenceKindError,
  InvalidReferenceValueError,
  InvalidTransactionStateError,
  InvalidWagerAmountError,
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

/** REFUND só referencia BET (seção 7 regra 3 do README — mais restrito que ROLLBACK). */
const VALID_REFUND_REFERENCE_KINDS = new Set([WagerTransactionKind.Bet]);

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
   *  (REFUND/ROLLBACK exigem, WIN opcional, demais kinds proíbem — seção 7.1/7.2)
   *  e que o valor monetário é estritamente positivo — invariante de
   *  WagerTransaction, não de Money (que precisa continuar aceitando zero/
   *  negativo como value object genérico, ver InvalidWagerAmountError).
   *  Aplica-se a OPENING também: CreateWalletUseCase só chama create() com
   *  kind OPENING quando initialBalance > 0 (o caso initialBalance === 0
   *  retorna antes, sem criar nenhuma WagerTransaction), então esta
   *  invariante nunca quebra esse caminho — apenas o reforça. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertReferenceRequirement(props.kind, props.referenceExternalTransactionId);
    WagerTransaction.assertPositiveAmount(props.money);

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

  /** Número TOTAL de tentativas de resolução de referência já realizadas,
   *  incluindo a tentativa inicial que levou a PENDING_REFERENCE (markPendingReference
   *  sempre incrementa, mesmo na primeira chamada) — nunca um contador de
   *  retries adicionais além dela. maxAttempts (ReferenceRetryPolicy) é
   *  comparado diretamente contra este valor. */
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

  /** Seção 7 regras 2, 3 e 5 do README — validado uma única vez, reusado tanto
   *  pelo fluxo normal (referência já resolvida na primeira tentativa) quanto
   *  pelo worker de PENDING_REFERENCE (referência resolvida depois). Cobre o
   *  que balanceEffectFor() não cobre: identidade (provider/player/wallet/
   *  moeda/rodada), status PROCESSED, valor exato, e REFUND→BET (mais
   *  restrito que a checagem de kind do ROLLBACK, já feita em
   *  balanceEffectFor). Só chamado quando há uma referência de fato a validar
   *  (REFUND/ROLLBACK sempre; WIN apenas se optou por referenciar). */
  assertCompatibleReference(reference: WagerTransaction): void {
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new IncompatibleReferenceError(`reference must be PROCESSED, was "${reference.status}"`);
    }
    if (reference.providerId !== this.providerId) {
      throw new IncompatibleReferenceError('reference belongs to a different provider');
    }
    if (reference.playerId !== this.playerId) {
      throw new IncompatibleReferenceError('reference belongs to a different player');
    }
    if (reference.walletId !== this.walletId) {
      throw new IncompatibleReferenceError('reference belongs to a different wallet');
    }
    if (reference.money.currency !== this.money.currency) {
      throw new IncompatibleReferenceError('reference has a different currency');
    }
    if (reference.roundId !== this.roundId) {
      throw new IncompatibleReferenceError('reference belongs to a different round');
    }
    if (this.kind === WagerTransactionKind.Refund && !VALID_REFUND_REFERENCE_KINDS.has(reference.kind)) {
      throw new IncompatibleReferenceError(`REFUND cannot reference a transaction of kind "${reference.kind}"`);
    }
    if (
      (this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback) &&
      !this.money.equals(reference.money)
    ) {
      throw new IncompatibleReferenceError('amount must equal the reference amount exactly (partial reversal is out of scope)');
    }
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attemptedTransition);
    }
  }

  private static assertPositiveAmount(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidWagerAmountError(money.toJSON().amount);
    }
  }

  /** Três semânticas deliberadamente separadas — nunca colapsadas numa única
   *  checagem de "presente/ausente":
   *
   *  - required (REFUND/ROLLBACK): precisa de referência VÁLIDA.
   *    undefined/''/whitespace → MissingReferenceError.
   *  - forbidden (BET/LOSS): qualquer valor DEFINIDO é erro, válido ou não —
   *    '' também é rejeitado aqui (não deveria ter sido enviado de jeito
   *    nenhum). undefined → UnexpectedReferenceError.
   *  - optional (WIN): undefined é permitido (nenhuma referência); se
   *    definido, precisa ser válido. ''/whitespace definido →
   *    InvalidReferenceValueError (distinto de Missing/Unexpected: WIN não
   *    exige referência, então não é "faltou"; WIN pode legitimamente ter
   *    referência, então não é "não pode existir").
   *
   *  Definida-mas-inválida (''/whitespace) NUNCA é tratada como "ausente" em
   *  nenhum dos três casos — fecha a divergência real encontrada entre este
   *  método (antes: `!== undefined`, contava '' como presente) e
   *  ProcessWagerTransactionUseCase (antes: `if (truthy)`, tratava '' como
   *  ausente e nunca resolvia a referência), que permitia um REFUND com
   *  referência '' mover saldo sem a referência jamais ter sido validada
   *  (hardening SQS). O parser SQS e a validação de borda HTTP continuam
   *  barrando isso mais cedo — esta é a garantia final, no domínio, que não
   *  depende de nenhum transporte específico. */
  private static assertReferenceRequirement(kind: WagerTransactionKind, referenceExternalTransactionId?: string): void {
    const isPresent = referenceExternalTransactionId !== undefined;
    const isValidReference = isPresent && referenceExternalTransactionId.trim().length > 0;
    const required = KINDS_REQUIRING_REFERENCE.has(kind);
    const optional = KINDS_ALLOWING_OPTIONAL_REFERENCE.has(kind);

    if (required && !isValidReference) {
      throw new MissingReferenceError(kind);
    }
    if (!required && !optional && isPresent) {
      throw new UnexpectedReferenceError(kind);
    }
    if (optional && isPresent && !isValidReference) {
      throw new InvalidReferenceValueError(kind);
    }
  }
}
