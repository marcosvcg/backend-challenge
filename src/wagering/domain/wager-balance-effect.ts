/**
 * Efeito no saldo, do ponto de vista de wagering — não é LedgerDirection (que
 * pertence exclusivamente ao módulo wallet/ledger). A camada de aplicação traduz:
 * Debit -> wallet.debit(...), Credit -> wallet.credit(...), None -> nenhuma chamada.
 */
export enum WagerBalanceEffect {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
  None = 'NONE',
}
