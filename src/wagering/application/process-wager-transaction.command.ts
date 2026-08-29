import { Money } from '../../wallet/domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';

export type CommandOrigin = 'http' | 'queue';

export interface ProcessWagerTransactionCommand {
  origin: CommandOrigin;
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
  /** Presentes apenas quando origin === 'queue'. */
  messageId?: string;
  consumerName?: string;
  /** Contexto de correlação de entrada (propagado de header HTTP ou da mensagem
   *  SQS) — diferente de eventId/transactionId/ledgerEntryId, que são gerados
   *  internamente pelo use case via IdGenerator, nunca pelo caller. */
  correlationId: string;
  causationId?: string;
}
