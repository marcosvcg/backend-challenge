import { Money } from '../domain/money';

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  initialBalance: Money;
  correlationId: string;
  causationId?: string;
}
