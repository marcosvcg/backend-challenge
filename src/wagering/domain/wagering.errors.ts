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
