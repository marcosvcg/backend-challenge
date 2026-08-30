import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';

/** Cliente SQS real apontando para o LocalStack, para testes de integração. */
export function createTestSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.SQS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export const TEST_OUTBOUND_QUEUE_NAME = process.env.SQS_OUTBOUND_QUEUE_NAME ?? 'wager-events.fifo';

/** Reset de fixture entre testes — mensagens acumuladas de execuções
 *  anteriores da suíte poluiriam qualquer teste que dependa de "a fila
 *  contém exatamente isto". Exclusivo de suporte a teste, nunca usado por
 *  código de produção (mesmo espírito de truncateAllTables no Postgres). */
export async function purgeTestQueue(queueUrl: string): Promise<void> {
  const client = createTestSqsClient();
  try {
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    // LocalStack limita PurgeQueue a 1x/60s por fila (mesma regra da AWS
    // real); em execuções muito próximas isso pode rejeitar — não é motivo
    // para falhar a suíte, só significa que a fila já estava sendo purgada.
  }
}
