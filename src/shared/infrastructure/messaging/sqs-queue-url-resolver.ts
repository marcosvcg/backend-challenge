import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

/** Resolve o nome de uma fila (config canônica: SQS_INBOUND_QUEUE_NAME/
 *  SQS_OUTBOUND_QUEUE_NAME) para a URL completa que ReceiveMessage/
 *  SendMessage exigem — via GetQueueUrlCommand, nunca derivando a URL
 *  manualmente do padrão de path do LocalStack (isso acoplaria produção ao
 *  emulador). Só chamado quando START_BACKGROUND_WORKERS === 'true', dentro
 *  de onApplicationBootstrap() de cada runtime — nunca em tempo de
 *  construção de módulo/provider factory, para que testes que só sobem a
 *  AppModule (workers desligados) nunca precisem de LocalStack alcançável
 *  (ARCHITECTURE.md seção 30). */
export class SqsQueueUrlResolver {
  constructor(private readonly client: SQSClient) {}

  async resolve(queueName: string): Promise<string> {
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!result.QueueUrl) {
      throw new Error(`GetQueueUrlCommand for "${queueName}" did not return a QueueUrl.`);
    }
    return result.QueueUrl;
  }
}
