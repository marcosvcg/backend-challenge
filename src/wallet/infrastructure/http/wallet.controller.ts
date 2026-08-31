import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { GetWalletUseCase } from '../../application/get-wallet.use-case';
import { GetWalletLedgerUseCase } from '../../application/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case';
import { Money } from '../../domain/money';
import { WalletAlreadyExistsError } from '../../domain/wallet-already-exists.error';
import { decodeLedgerCursor } from '../../application/wallet-ledger-cursor';
import { parseLedgerLimit } from '../../application/wallet-ledger-limit';
import type { IdGenerator } from '../../../shared/application/id-generator';
import { ID_GENERATOR } from '../../../shared/infrastructure/shared.tokens';
import { CreateWalletDto } from './create-wallet.dto';
import { toWalletResponse, WalletResponse } from './wallet.presenter';
import { toWalletLedgerResponse, WalletLedgerResponse } from './wallet-ledger.presenter';
import { toWalletReconciliationResponse, WalletReconciliationResponse } from './wallet-reconciliation.presenter';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getWalletLedger: GetWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
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

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursorParam: string | undefined,
    @Query('limit') limitParam: string | undefined,
  ): Promise<WalletLedgerResponse> {
    // Existência da wallet é checada aqui (reaproveitando GetWalletUseCase,
    // a MESMA consulta de GET /wallets/:walletId, nunca duplicada) — 404
    // explícito distingue "wallet não existe" de "wallet existe, ledger
    // vazio" (200, entries: []). GetWalletLedgerUseCase nunca decide isso —
    // só sabe paginar o ledger de um walletId que o caller já confirmou existir.
    const wallet = await this.getWallet.execute(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet "${walletId}" not found.`);
    }

    const limit = parseLedgerLimit(limitParam);
    const cursor = cursorParam !== undefined ? decodeLedgerCursor(cursorParam) : undefined;

    const result = await this.getWalletLedger.execute(walletId, cursor, limit);
    return toWalletLedgerResponse(result);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<WalletReconciliationResponse> {
    // Caso de uso completo: ReconcileWalletUseCase busca a própria wallet
    // (via WalletQueryRepository — a MESMA porta que GetWalletUseCase usa,
    // nunca duplicada; os dois nunca dependem um do outro) e devolve um
    // resultado discriminado. O controller só converte wallet-not-found em
    // 404 — nenhuma outra decisão de existência mora aqui.
    const result = await this.reconcileWallet.execute(walletId);
    if (result.kind === 'wallet-not-found') {
      throw new NotFoundException(`Wallet "${walletId}" not found.`);
    }

    return toWalletReconciliationResponse(walletId, result.reconciliation);
  }
}
