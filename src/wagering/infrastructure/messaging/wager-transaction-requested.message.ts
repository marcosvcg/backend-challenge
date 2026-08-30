/** Shape exato da mensagem SQS de entrada (README seção 10) —
 *  WagerTransactionRequested. `data.kind` chega como string; a validação/
 *  parsing para WagerTransactionKind é responsabilidade do consumer. */
export interface WagerTransactionRequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}
