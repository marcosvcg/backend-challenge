export enum WagerTransactionKind {
  /** Interno: não pode ser submetido pela API nem pela fila (seção 6.3 do README). */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}
