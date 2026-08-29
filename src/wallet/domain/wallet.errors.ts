export class InsufficientBalanceError extends Error {
  constructor(walletId: string) {
    super(`Wallet "${walletId}" has insufficient balance for this debit.`);
    this.name = 'InsufficientBalanceError';
  }
}

export class NonPositiveAmountError extends Error {
  constructor(operation: 'debit' | 'credit') {
    super(`Cannot ${operation} a non-positive amount: balance changes must be strictly positive.`);
    this.name = 'NonPositiveAmountError';
  }
}

export class UnbalancedLedgerEntryError extends Error {
  constructor() {
    super('Ledger entry arithmetic is inconsistent: balanceBefore ± money must equal balanceAfter.');
    this.name = 'UnbalancedLedgerEntryError';
  }
}
