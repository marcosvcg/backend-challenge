import { WagerTransactionRequestedMessage } from './wager-transaction-requested.message';
import { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction.command';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { Money } from '../../../wallet/domain/money';
import { hashCanonicalWagerPayload } from '../../application/canonical-wager-payload';

const CONSUMER_NAME = 'wagering-sqs-consumer';

/** sqsMessageId: o Message.MessageId atribuído pelo próprio SQS à entrega —
 *  NUNCA o `messageId` do body (campo controlado pelo produtor, sem
 *  autoridade sobre deduplicação de transporte). Vira cmd.messageId, a
 *  identidade persistida no Inbox (consumerName, messageId) — dedupe de
 *  ENTREGA, distinta de idempotencyKey (identidade lógica/financeira,
 *  comparada via payloadHash) e de correlationId (rastreabilidade de log,
 *  aqui herdado do messageId do body só porque a mensagem em si não carrega
 *  um correlationId de negócio próprio — README seção 10). Confundir os dois
 *  IDs faria o Inbox deduplicar pela identidade "errada": duas entregas
 *  distintas do SQS com o mesmo body.messageId (produtor bugado/hostil)
 *  colapsariam indevidamente; ou pior, duas mensagens de fato diferentes que
 *  por acaso compartilhassem um body.messageId jamais seriam processadas
 *  como entregas distintas pelo Inbox.
 *
 *  payloadHash: hashCanonicalWagerPayload — MESMA função usada pelo
 *  controller HTTP, nunca uma segunda implementação "parecida" (hardening
 *  SQS: antes desta correção, o mapper hasheava `data` inteiro, incluindo
 *  idempotencyKey, produzindo um hash diferente do HTTP para a mesma
 *  transação lógica — cross-transport idempotency quebrada). */
export function wagerTransactionMessageToCommand(
  message: WagerTransactionRequestedMessage,
  sqsMessageId: string,
): ProcessWagerTransactionCommand {
  const { data } = message;

  return {
    origin: 'queue',
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    payloadHash: hashCanonicalWagerPayload({
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: { amount: data.money.amount, currency: data.money.currency },
      ...(data.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
        : {}),
    }),
    walletId: data.walletId,
    playerId: data.playerId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind as WagerTransactionKind,
    money: Money.from(data.money),
    ...(data.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
      : {}),
    messageId: sqsMessageId,
    consumerName: CONSUMER_NAME,
    correlationId: message.messageId,
  };
}

export { CONSUMER_NAME };
