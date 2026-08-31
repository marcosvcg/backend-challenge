import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { GetWagerTransactionByIdUseCase } from '../../application/get-wager-transaction-by-id.use-case';
import { GetWagerTransactionByProviderAndExternalIdUseCase } from '../../application/get-wager-transaction-by-provider-and-external-id.use-case';
import { toWagerTransactionResponse, WagerTransactionResponse } from './wager-transaction.presenter';

/** Controller dedicado só a consultas — separado de WagerTransactionController
 *  (POST /wagering/transactions, seção 26), que continua focado
 *  exclusivamente em submissão. As duas rotas aqui têm prefixos de path
 *  completamente diferentes (/wagering/transactions/... vs /providers/...),
 *  por isso @Controller() sem prefixo de classe, com o path completo
 *  declarado em cada @Get(). Só recebe os use cases de leitura prontos —
 *  nunca MikroORM, repository de escrita ou TransactionRunner. */
@Controller()
export class WagerTransactionQueryController {
  constructor(
    private readonly getById: GetWagerTransactionByIdUseCase,
    private readonly getByProviderAndExternalId: GetWagerTransactionByProviderAndExternalIdUseCase,
  ) {}

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId', ParseUUIDPipe) transactionId: string): Promise<WagerTransactionResponse> {
    const transaction = await this.getById.execute(transactionId);
    if (!transaction) {
      throw new NotFoundException(`WagerTransaction "${transactionId}" not found.`);
    }
    return toWagerTransactionResponse(transaction);
  }

  // providerId/externalTransactionId são identificadores externos livres
  // (definidos pelo provider, não pelo nosso sistema) — sem ParseUUIDPipe ou
  // qualquer validação de formato que o README não exige; um valor que não
  // corresponde a nada existente vira 404, nunca 400.
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    const transaction = await this.getByProviderAndExternalId.execute(providerId, externalTransactionId);
    if (!transaction) {
      throw new NotFoundException(
        `WagerTransaction for providerId="${providerId}" externalTransactionId="${externalTransactionId}" not found.`,
      );
    }
    return toWagerTransactionResponse(transaction);
  }
}
