import { canonicalPayloadHash } from '../../shared/idempotency/canonical-payload-hash';

export interface CanonicalWagerPayloadInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Único ponto de montagem do payload de negócio de uma WagerTransaction
 *  externa (BET/WIN/LOSS/REFUND/ROLLBACK) — usado tanto pelo controller HTTP
 *  (WagerTransactionController) quanto pelo mapper SQS
 *  (wagerTransactionMessageToCommand) para produzir o MESMO payloadHash para
 *  a mesma transação lógica, independente do transporte que a carregou.
 *
 *  Inclui exclusivamente os campos que definem a transação. Exclui
 *  deliberadamente: idempotencyKey (identidade lógica, não payload — usada
 *  como CHAVE de busca por WagerTransaction.findByIdempotencyKey, nunca como
 *  parte do payload a comparar), qualquer identificador de transporte
 *  (Idempotency-Key header, AWS MessageId, correlationId, metadata SQS,
 *  timestamps de entrega, receiveCount). Duas implementações "parecidas" uma
 *  para HTTP e outra para SQS foi o bug real que motivou esta função — antes
 *  dela, o mapper SQS passava `data` inteiro (que inclui idempotencyKey) para
 *  canonicalPayloadHash, produzindo um hash diferente do HTTP para o mesmo
 *  payload lógico (confirmado empiricamente: hashes diferentes para os
 *  mesmos providerId/externalTransactionId/.../money, cross-transport). */
export function canonicalWagerPayload(input: CanonicalWagerPayloadInput): Record<string, unknown> {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    ...(input.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  };
}

export function hashCanonicalWagerPayload(input: CanonicalWagerPayloadInput): string {
  return canonicalPayloadHash(canonicalWagerPayload(input));
}
