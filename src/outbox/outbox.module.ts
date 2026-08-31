import { Module } from '@nestjs/common';
import { OutboxPublisherRuntime } from './infrastructure/outbox-publisher.runtime';

/** Primeira composition root Nest do bounded context outbox — até este
 *  incremento, PublishPendingOutboxMessagesUseCase nunca tinha sido
 *  conectado ao Nest DI, só instanciado manualmente em testes.
 *
 *  Nenhum provider fixo para PublishPendingOutboxMessagesUseCase aqui: ele
 *  depende de SqsPublisherAdapter, que por sua vez depende da URL da fila de
 *  saída resolvida via GetQueueUrlCommand — resolver isso numa provider
 *  factory síncrona de módulo (tempo de boot) violaria a exigência de nunca
 *  fazer chamada AWS fora do controle do gate START_BACKGROUND_WORKERS.
 *  OutboxPublisherRuntime monta o use case internamente, dentro de
 *  onApplicationBootstrap(), só quando o gate está ligado
 *  (ARCHITECTURE.md seção 30). */
@Module({
  providers: [OutboxPublisherRuntime],
})
export class OutboxModule {}
