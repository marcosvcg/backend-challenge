import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletAlreadyExistsError } from '../../domain/wallet-already-exists.error';
import { WalletRow } from './wallet.row';
import { WalletLedgerEntryRow } from './wallet-ledger-entry.row';
import { walletDomainToRow, walletRowToDomain } from './wallet.mapper';
import { walletLedgerEntryDomainToRow } from './wallet-ledger-entry.mapper';
import { MetricsPort } from '../../../shared/application/metrics';
import { WALLET_LOCK_ACQUISITION_DURATION_SECONDS } from '../../application/wallet-lock-metric';

const PLAYER_CURRENCY_UNIQUE_CONSTRAINT = 'wallet_player_currency_unique';

const noopMetrics: MetricsPort = {
  incrementCounter: () => {},
  setGauge: () => {},
  observeHistogram: () => {},
};

/** Construído sempre com o EntityManager "forked" da transação corrente —
 *  nunca o EntityManager global do módulo Nest (ver ARCHITECTURE.md seção 3/4).
 *
 *  metrics é opcional (default no-op) — alteração mínima e aditiva para
 *  instrumentar wallet_lock_acquisition_duration_seconds em
 *  findByIdForUpdate() (ARCHITECTURE.md seção 31): duração da chamada
 *  PESSIMISTIC_WRITE em si, um fato de infraestrutura verdadeiro
 *  independente do desfecho da transação — nunca uma contagem de resultado
 *  de negócio, então seguro de medir aqui, mesmo antes do commit. */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async findByIdForUpdate(id: string): Promise<Wallet> {
    const startedAt = Date.now();
    const row = await this.em.findOneOrFail(WalletRow, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    this.metrics.observeHistogram(WALLET_LOCK_ACQUISITION_DURATION_SECONDS, (Date.now() - startedAt) / 1000);
    return walletRowToDomain(row);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRow, { id });
    return row ? walletRowToDomain(row) : undefined;
  }

  async create(wallet: Wallet): Promise<void> {
    try {
      this.em.create(WalletRow, walletDomainToRow(wallet));
      await this.em.flush();
    } catch (err) {
      throw this.translateConflict(err, wallet);
    }
  }

  async saveWithLedger(wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
    const walletRow = walletDomainToRow(wallet);
    const entryRow = walletLedgerEntryDomainToRow(entry);

    this.em.assign(this.em.getReference(WalletRow, wallet.id), walletRow);
    this.em.create(WalletLedgerEntryRow, entryRow);

    await this.em.flush();
  }

  /** Traduz a violação real da UNIQUE(player_id, currency) do Postgres em
   *  WalletAlreadyExistsError — nunca detectado via SELECT prévio
   *  (ARCHITECTURE.md seção 7). Só traduz a constraint específica: qualquer
   *  outra UniqueConstraintViolationException propaga como erro inesperado. */
  private translateConflict(err: unknown, wallet: Wallet): unknown {
    if (err instanceof UniqueConstraintViolationException) {
      const constraintName = (err as { constraint?: string }).constraint ?? err.message;
      if (constraintName.includes(PLAYER_CURRENCY_UNIQUE_CONSTRAINT)) {
        return new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
    }
    return err;
  }
}
