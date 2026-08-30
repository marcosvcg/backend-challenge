import { Wallet } from '../domain/wallet';
import { WalletAlreadyExistsError } from '../domain/wallet-already-exists.error';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction-kind';
import { WagerTransactionProcessed } from '../../wagering/domain/wager-transaction-processed';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed';
import { CreateWalletTransactionRunner } from './ports/create-wallet-unit-of-work';
import { CreateWalletCommand } from './create-wallet.command';
import { CreateWalletResult } from './create-wallet.result';
import { IdGenerator } from '../../shared/application/id-generator';
import { Clock } from '../../shared/application/clock';
import { EventContext } from '../../shared/domain/event-context';
import { canonicalPayloadHash } from '../../shared/idempotency/canonical-payload-hash';

export class CreateWalletUseCase {
  constructor(
    private readonly runner: CreateWalletTransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    try {
      return await this.runner.run(async (uow) => {
        const walletId = this.ids.newId();
        const now = this.clock.now();

        // Wallet.open() sempre nasce com saldo zero/version 1. Persistida ANTES
        // de qualquer crédito de abertura — dentro da mesma transação SQL, esse
        // estado intermediário nunca fica visível a outra conexão. Isso respeita
        // a cadeia real de FK: wallet → wager_transaction → wallet_ledger_entry.
        const wallet = Wallet.open({ id: walletId, playerId: cmd.playerId, currency: cmd.currency, at: now });
        await uow.wallet.create(wallet);

        if (cmd.initialBalance.isZero()) {
          return CreateWalletResult.created(wallet);
        }

        // OPENING é interna: providerId='internal', identidade determinística
        // a partir do walletId (no máximo uma OPENING por wallet), payloadHash
        // canônico sobre os campos que definem a operação (seção 6.3 do README:
        // OPENING nunca chega via API/fila — só é construída aqui).
        const openingPayload = {
          kind: WagerTransactionKind.Opening,
          walletId,
          playerId: cmd.playerId,
          currency: cmd.currency,
          amount: cmd.initialBalance.toJSON().amount,
        };

        const transaction = WagerTransaction.create({
          id: this.ids.newId(),
          providerId: 'internal',
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `opening:${walletId}`,
          payloadHash: canonicalPayloadHash(openingPayload),
          walletId,
          playerId: cmd.playerId,
          roundId: `opening:${walletId}`,
          gameId: 'wallet-opening',
          kind: WagerTransactionKind.Opening,
          money: cmd.initialBalance,
          createdAt: now,
        });

        const ledgerEntry = wallet.credit(cmd.initialBalance, transaction.id, this.ids.newId(), now);
        transaction.markProcessed(undefined, wallet.balance, now);

        // wager_transaction PRIMEIRO: wallet_ledger_entry.transaction_id tem FK
        // para wager_transaction.id (ARCHITECTURE.md seção 18/19). saveWithLedger
        // atualiza a wallet do saldo zero para o saldo final e insere o ledger.
        // create(), não update(): a OPENING nasce nesta execução, nunca existiu antes.
        await uow.wagerTransaction.create(transaction);
        await uow.wallet.saveWithLedger(wallet, ledgerEntry);

        await uow.outbox.enqueue(WagerTransactionProcessed.from(transaction, this.newEventContext(cmd, now)));
        await uow.outbox.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, this.newEventContext(cmd, now)));

        return CreateWalletResult.created(wallet);
      });
    } catch (err) {
      if (err instanceof WalletAlreadyExistsError) {
        return CreateWalletResult.conflict();
      }
      throw err;
    }
  }

  private newEventContext(cmd: CreateWalletCommand, now: Date): EventContext {
    return {
      eventId: this.ids.newId(),
      correlationId: cmd.correlationId,
      ...(cmd.causationId !== undefined ? { causationId: cmd.causationId } : {}),
      occurredAt: now,
    };
  }
}
