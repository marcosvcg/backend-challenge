import { WagerTransactionRequestedMessage } from './wager-transaction-requested.message';
import { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction.command';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { Money } from '../../../wallet/domain/money';
import { canonicalPayloadHash } from '../../../shared/idempotency/canonical-payload-hash';

const CONSUMER_NAME = 'wagering-sqs-consumer';

/** messageId como correlationId: correlaciona todos os eventos de saída
 *  gerados por este comando de entrada específico — a mensagem SQS não
 *  carrega um correlationId próprio (README seção 10). */
export function wagerTransactionMessageToCommand(message: WagerTransactionRequestedMessage): ProcessWagerTransactionCommand {
  const { data } = message;

  return {
    origin: 'queue',
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    payloadHash: canonicalPayloadHash(data as unknown as Record<string, unknown>),
    walletId: data.walletId,
    playerId: data.playerId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind as WagerTransactionKind,
    money: Money.from(data.money),
    ...(data.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
      : {}),
    messageId: message.messageId,
    consumerName: CONSUMER_NAME,
    correlationId: message.messageId,
  };
}

export { CONSUMER_NAME };
