import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { Money } from '../domain/money';
import { LedgerDirection } from '../domain/ledger-direction';
import { WalletQueryRepository } from './ports/wallet-query.repository';
import { WalletLedgerQueryRepository } from './ports/wallet-ledger-query.repository';
import { MetricsPort } from '../../shared/application/metrics';
import { Logger } from '../../shared/application/logger';
import {
  WALLET_RECONCILIATION_DIVERGENCES_TOTAL,
  ReconciliationDivergenceReason,
} from './wallet-reconciliation-metric';

export interface ReconciledWallet {
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export type ReconcileWalletResult =
  | { kind: 'wallet-not-found' }
  | { kind: 'reconciled'; reconciliation: ReconciledWallet };

/** Caso de uso completo: recebe walletId, busca a wallet (WalletQueryRepository
 *  — a MESMA porta que GetWalletUseCase usa, nunca duplicada; este use case
 *  nunca depende de GetWalletUseCase, os dois são consumidores independentes
 *  da mesma porta de leitura), e devolve um resultado discriminado —
 *  wallet-not-found | reconciled. O controller só converte wallet-not-found
 *  em 404; toda a decisão de "a wallet existe?" mora aqui, não espalhada
 *  entre controller e use case (ARCHITECTURE.md seção 29).
 *
 *  Estritamente leitura — nenhuma escrita em nenhum ponto (README seção 9:
 *  "divergências não são corrigidas silenciosamente"). Reconstrói o saldo
 *  combinando quatro checagens independentes, porque nenhuma sozinha detecta
 *  todos os tipos de corrupção possíveis:
 *
 *  1. Ponto de ancoragem: se há algum lançamento, entries[0].balanceBefore
 *     DEVE ser Money.zero(currency) — não por suposição, mas porque
 *     Wallet.open() é a única factory de criação em todo o código de
 *     produção e sempre nasce em zero (nenhum outro caminho cria uma wallet
 *     com saldo não-zero sem passar por applyMovement(), que sempre gera um
 *     lançamento). Se entries[0].balanceBefore !== zero, o valor persistido
 *     é usado no cálculo mesmo assim (nunca substituído por zero à força).
 *  2. Aritmética interna de cada lançamento: entry.isBalanced() (balanceBefore
 *     ± amount === balanceAfter) para TODO lançamento — detecta um
 *     lançamento cuja própria aritmética está corrompida, mesmo que a cadeia
 *     de continuidade com o vizinho e o saldo final "por acaso" batam.
 *  3. Continuidade da cadeia: entries[i].balanceAfter === entries[i+1].balanceBefore
 *     para todo par consecutivo — detecta um lançamento fora de posição ou
 *     um gap, algo que uma soma simples nunca detectaria.
 *  4. Soma final: calculatedBalance (derivado de entries[0].balanceBefore +
 *     Σ CREDIT - Σ DEBIT, por soma independente — nunca copiando balanceAfter
 *     do último lançamento) precisa bater com storedBalance (wallet.balance).
 *
 *  consistent só é true se as quatro se sustentarem. Ledger vazio →
 *  calculatedBalance = Money.zero(wallet.currency) (única wallet consistente
 *  com "nenhum lançamento existe", pela mesma razão do item 1).
 *
 *  Um incremento de métrica por execução inconsistente, nunca um por tipo de
 *  inconsistência detectado: se múltiplos problemas independentes existirem
 *  na mesma execução, reason reflete a PRIMEIRA checagem que falha, numa
 *  ordem de prioridade FIXA — invalid_anchor → invalid_entry → broken_chain →
 *  balance_mismatch — nunca a ordem em que os lançamentos foram varridos. */
export class ReconcileWalletUseCase {
  constructor(
    private readonly walletRepository: WalletQueryRepository,
    private readonly ledgerRepository: WalletLedgerQueryRepository,
    private readonly metrics: MetricsPort,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      return { kind: 'wallet-not-found' };
    }

    const entries = await this.ledgerRepository.fetchAll(walletId);
    const storedBalance = wallet.balance;

    const { calculatedBalance, reason: reconstructionReason } = this.reconstruct(entries, wallet.currency);
    const difference = storedBalance.subtract(calculatedBalance);
    const balanceMismatch = !difference.isZero();

    // Ordem de prioridade FIXA, independente da ordem em que os lançamentos
    // foram varridos: invalid_anchor → invalid_entry → broken_chain →
    // balance_mismatch. reconstructionReason já vem computado nessa
    // prioridade por reconstruct() (ver comentário lá).
    const reason: ReconciliationDivergenceReason | undefined =
      reconstructionReason ?? (balanceMismatch ? 'balance_mismatch' : undefined);
    const consistent = reason === undefined;

    const reconciliation: ReconciledWallet = {
      storedBalance,
      calculatedBalance,
      difference,
      consistent,
      checkedEntries: entries.length,
    };

    if (!consistent) {
      this.metrics.incrementCounter(WALLET_RECONCILIATION_DIVERGENCES_TOTAL, { reason });
      this.logger.warn('Wallet reconciliation detected a divergence', {
        event: 'wallet_reconciliation_divergence',
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        checkedEntries: entries.length,
        reason,
      });
    }

    return { kind: 'reconciled', reconciliation };
  }

  /** Retorna reason preenchido assim que a ancoragem, algum lançamento
   *  individual, ou a cadeia quebra — calculatedBalance continua sendo
   *  computado até o fim mesmo assim (usa os valores reais persistidos,
   *  nunca substitui nada por zero), para que difference/checkedEntries no
   *  resultado reflitam o estado real do ledger, não um cálculo abortado.
   *
   *  reason segue SEMPRE a ordem de prioridade invalid_anchor → invalid_entry
   *  → broken_chain (balance_mismatch é decidido pelo caller, fora deste
   *  método, comparando o resultado final com storedBalance) — mesmo que,
   *  por exemplo, um lançamento no meio da lista viole a cadeia antes de um
   *  lançamento posterior ter aritmética interna quebrada, invalid_entry
   *  ainda prevalece sobre broken_chain no reason final. */
  private reconstruct(
    entries: WalletLedgerEntry[],
    currency: string,
  ): { calculatedBalance: Money; reason?: ReconciliationDivergenceReason } {
    if (entries.length === 0) {
      return { calculatedBalance: Money.zero(currency) };
    }

    const anchorInvalid = !entries[0]!.balanceBefore.isZero();

    let hasUnbalancedEntry = false;
    let chainBroken = false;
    let running = entries[0]!.balanceBefore;

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;

      if (!entry.isBalanced()) {
        hasUnbalancedEntry = true;
      }

      running = entry.direction === LedgerDirection.Debit ? running.subtract(entry.money) : running.add(entry.money);

      const next = entries[i + 1];
      if (next && !entry.balanceAfter.equals(next.balanceBefore)) {
        chainBroken = true;
      }
    }

    const reason: ReconciliationDivergenceReason | undefined = anchorInvalid
      ? 'invalid_anchor'
      : hasUnbalancedEntry
        ? 'invalid_entry'
        : chainBroken
          ? 'broken_chain'
          : undefined;

    return { calculatedBalance: running, ...(reason !== undefined ? { reason } : {}) };
  }
}
