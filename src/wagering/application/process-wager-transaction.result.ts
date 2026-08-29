import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';

export type ProcessWagerTransactionResultKind =
  | 'already-acked'
  | 'permanent-error'
  | 'idempotency-conflict'
  | 'replay'
  | 'pending-reference'
  | 'processed'
  | 'rejected';

export class ProcessWagerTransactionResult {
  private constructor(
    public readonly kind: ProcessWagerTransactionResultKind,
    /** true quando o transporte SQS pode confirmar (ACK) a mensagem com
     *  segurança — não implica que a transação seja terminal no domínio
     *  (PENDING_REFERENCE é ackable e não-terminal ao mesmo tempo). */
    public readonly ackable: boolean,
    public readonly transaction?: WagerTransaction,
    public readonly permanentErrorCode?: string,
    public readonly idempotencyKey?: string,
  ) {}

  static alreadyAcked(): ProcessWagerTransactionResult {
    return new ProcessWagerTransactionResult('already-acked', true);
  }

  static permanentError(code: string): ProcessWagerTransactionResult {
    return new ProcessWagerTransactionResult('permanent-error', false, undefined, code);
  }

  static idempotencyConflict(idempotencyKey: string): ProcessWagerTransactionResult {
    return new ProcessWagerTransactionResult('idempotency-conflict', true, undefined, undefined, idempotencyKey);
  }

  static replay(transaction: WagerTransaction): ProcessWagerTransactionResult {
    return new ProcessWagerTransactionResult('replay', true, transaction);
  }

  static pendingReference(transaction: WagerTransaction): ProcessWagerTransactionResult {
    return new ProcessWagerTransactionResult('pending-reference', true, transaction);
  }

  static from(transaction: WagerTransaction): ProcessWagerTransactionResult {
    const kind = transaction.status === WagerTransactionStatus.Rejected ? 'rejected' : 'processed';
    return new ProcessWagerTransactionResult(kind, true, transaction);
  }
}
