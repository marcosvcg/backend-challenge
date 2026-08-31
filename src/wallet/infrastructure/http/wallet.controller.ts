import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { GetWalletUseCase } from '../../application/get-wallet.use-case';
import { Money } from '../../domain/money';
import { WalletAlreadyExistsError } from '../../domain/wallet-already-exists.error';
import type { IdGenerator } from '../../../shared/application/id-generator';
import { ID_GENERATOR } from '../../../shared/infrastructure/shared.tokens';
import { CreateWalletDto } from './create-wallet.dto';
import { toWalletResponse, WalletResponse } from './wallet.presenter';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateWalletDto): Promise<WalletResponse> {
    const result = await this.createWallet.execute({
      playerId: dto.playerId,
      currency: dto.initialBalance.currency,
      initialBalance: Money.from(dto.initialBalance),
      correlationId: this.ids.newId(),
    });

    if (result.kind === 'conflict') {
      throw new WalletAlreadyExistsError(dto.playerId, dto.initialBalance.currency);
    }

    return toWalletResponse(result.wallet!);
  }

  @Get(':walletId')
  async getById(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<WalletResponse> {
    const wallet = await this.getWallet.execute(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet "${walletId}" not found.`);
    }
    return toWalletResponse(wallet);
  }
}
