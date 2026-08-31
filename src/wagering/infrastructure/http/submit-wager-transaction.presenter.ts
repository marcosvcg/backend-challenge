import { ProcessWagerTransactionResult } from '../../application/process-wager-transaction.result';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';

export interface SubmitWagerTransactionResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface SubmitWagerTransactionHttpResult {
  httpStatus: 200 | 202 | 409;
  body: SubmitWagerTransactionResponse | { message: string };
}

/** Único ponto de tradução ProcessWagerTransactionResult → HTTP para este
 *  endpoint — nenhuma condicional de status espalhada pelo controller.
 *
 *  `replay` espelha o status REAL da transação (PROCESSED/REJECTED → 200,
 *  PENDING_REFERENCE → 202), nunca um 200 fixo: idempotência responde "essa
 *  submissão já foi recebida?" (idempotentReplay: true), enquanto o status
 *  HTTP continua respondendo "qual é o estado atual do processamento?" — as
 *  duas perguntas são independentes. Por isso `processed`/`rejected`/
 *  `pending-reference`/`replay` compartilham a mesma lógica de status,
 *  baseada em transaction.status, não no result.kind (ARCHITECTURE.md
 *  seção 26).
 *
 *  `already-acked`/`permanent-error` nunca alcançam este mapper: só nascem
 *  do branch Inbox de ProcessWagerTransactionUseCase, que só roda quando
 *  origin === 'queue' — o controller HTTP nunca popula consumerName/
 *  messageId. Um `default` exaustivo garante que, se um dia isso mudar, o
 *  erro apareça alto (bug de wiring) em vez de ser silenciosamente
 *  interpretado como um status HTTP qualquer. */
export function toSubmitWagerTransactionHttpResult(result: ProcessWagerTransactionResult): SubmitWagerTransactionHttpResult {
  switch (result.kind) {
    case 'idempotency-conflict':
      return {
        httpStatus: 409,
        body: { message: `Idempotency-Key "${result.idempotencyKey}" was already used with a different payload.` },
      };

    case 'processed':
    case 'rejected':
    case 'pending-reference':
    case 'replay': {
      const transaction = result.transaction!;
      return {
        httpStatus: httpStatusForTransactionStatus(transaction.status),
        body: {
          transactionId: transaction.id,
          status: transaction.status as 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE',
          ...(transaction.resultBalance !== undefined ? { balance: transaction.resultBalance.toJSON() } : {}),
          ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
          idempotentReplay: result.kind === 'replay',
        },
      };
    }

    case 'already-acked':
    case 'permanent-error':
      throw new Error(
        `Unreachable via HTTP: ProcessWagerTransactionResult.kind "${result.kind}" only originates from the Inbox/queue branch — this indicates a composition-root bug (origin should always be "http" here).`,
      );
  }
}

function httpStatusForTransactionStatus(status: WagerTransactionStatus): 200 | 202 {
  if (status === WagerTransactionStatus.PendingReference) {
    return 202;
  }
  if (status === WagerTransactionStatus.Processed || status === WagerTransactionStatus.Rejected) {
    return 200;
  }
  throw new Error(`Unexpected WagerTransaction.status "${status}" reaching the HTTP submit endpoint.`);
}
