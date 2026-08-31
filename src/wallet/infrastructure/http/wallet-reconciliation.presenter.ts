import { ReconciledWallet } from '../../application/reconcile-wallet.use-case';

export interface WalletReconciliationResponse {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

export function toWalletReconciliationResponse(
  walletId: string,
  reconciliation: ReconciledWallet,
): WalletReconciliationResponse {
  return {
    walletId,
    storedBalance: reconciliation.storedBalance.toJSON(),
    calculatedBalance: reconciliation.calculatedBalance.toJSON(),
    difference: reconciliation.difference.toJSON(),
    consistent: reconciliation.consistent,
    checkedEntries: reconciliation.checkedEntries,
  };
}
