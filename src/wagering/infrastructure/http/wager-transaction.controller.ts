import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { Money } from '../../../wallet/domain/money';
import { canonicalPayloadHash } from '../../../shared/idempotency/canonical-payload-hash';
import { SubmitWagerTransactionDto } from './submit-wager-transaction.dto';
import { toSubmitWagerTransactionHttpResult } from './submit-wager-transaction.presenter';

@Controller('wagering/transactions')
export class WagerTransactionController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransactionUseCase) {}

  @Post()
  @HttpCode(200) // sobrescrito por res.status() abaixo conforme o resultado (200/202/409) — ver submit-wager-transaction.presenter.ts
  async submit(
    @Body() dto: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('The "Idempotency-Key" header is required.');
    }

    // payloadHash cobre exatamente o subconjunto de negócio do payload
    // (seção 9 do README) — nunca o header nem metadados de transporte.
    // Mesma função canonicalPayloadHash já usada pelo fluxo SQS (nunca uma
    // segunda implementação para HTTP).
    const payloadHash = canonicalPayloadHash({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: { amount: dto.money.amount, currency: dto.money.currency },
      ...(dto.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: dto.referenceExternalTransactionId }
        : {}),
    });

    const result = await this.processWagerTransaction.execute({
      origin: 'http',
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind as WagerTransactionKind,
      money: Money.from(dto.money),
      correlationId: idempotencyKey,
      ...(dto.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: dto.referenceExternalTransactionId }
        : {}),
    });

    const { httpStatus, body } = toSubmitWagerTransactionHttpResult(result);
    res.status(httpStatus);
    return body;
  }
}
