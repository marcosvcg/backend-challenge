import { WagerTransactionStatus } from './wager-transaction-status';

export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, currentStatus: WagerTransactionStatus, attemptedTransition: string) {
    super(
      `Transaction "${transactionId}" is in terminal status "${currentStatus}" and cannot transition via "${attemptedTransition}".`,
    );
    this.name = 'InvalidTransactionStateError';
  }
}

export class MissingReferenceError extends Error {
  constructor(kind: string) {
    super(`Transaction kind "${kind}" requires a referenceExternalTransactionId.`);
    this.name = 'MissingReferenceError';
  }
}

export class UnexpectedReferenceError extends Error {
  constructor(kind: string) {
    super(`Transaction kind "${kind}" must not carry a referenceExternalTransactionId.`);
    this.name = 'UnexpectedReferenceError';
  }
}

export class InvalidReferenceKindError extends Error {
  constructor(referencedKind: string) {
    super(
      `ROLLBACK cannot reference a transaction of kind "${referencedKind}". Only BET, WIN or REFUND are valid reversal targets.`,
    );
    this.name = 'InvalidReferenceKindError';
  }
}

/** Seção 7 regra 4 do README: uma referência não pode ser revertida duas vezes
 *  pelo mesmo tipo de operação (REFUND ou ROLLBACK). Espelha o índice único
 *  parcial wt_reference_reversal_unique — checado explicitamente na aplicação
 *  para produzir este failureCode de negócio; a constraint do banco é a defesa
 *  final contra race (ARCHITECTURE.md seção 9). */
export class DuplicateReversalError extends Error {
  constructor(referenceTransactionId: string, kind: string) {
    super(`Reference "${referenceTransactionId}" was already reversed by a processed "${kind}".`);
    this.name = 'DuplicateReversalError';
  }
}

/** Seção 7 regra 2 do README: a referência resolvida deve pertencer ao mesmo
 *  provider, player, wallet, moeda e rodada; regra 5: o valor de REFUND/ROLLBACK
 *  deve ser igual ao valor da referência (reversão parcial fora de escopo).
 *  Compartilhado entre o fluxo normal (referência já resolvida na primeira
 *  tentativa) e o worker de PENDING_REFERENCE (referência resolvida depois) —
 *  uma referência incompatível é sempre um erro de negócio, nunca uma
 *  diferença de tratamento entre os dois caminhos. */
export class IncompatibleReferenceError extends Error {
  constructor(reason: string) {
    super(`Reference is incompatible with this transaction: ${reason}.`);
    this.name = 'IncompatibleReferenceError';
  }
}
