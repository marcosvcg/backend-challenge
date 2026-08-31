import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionQueryRepository } from './ports/wager-transaction-query.repository';

export class GetWagerTransactionByProviderAndExternalIdUseCase {
  constructor(private readonly repository: WagerTransactionQueryRepository) {}

  async execute(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.repository.findByProviderAndExternalId(providerId, externalTransactionId);
  }
}
