export interface InboxClaimResult {
  isNew: boolean;
  payloadHashMatches: boolean;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING dentro da transação atual — é o próprio
   *  mecanismo de dedupe, nunca um SELECT prévio (ver ARCHITECTURE.md seção 10). */
  tryClaim(consumerName: string, messageId: string, payloadHash: string): Promise<InboxClaimResult>;

  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}
