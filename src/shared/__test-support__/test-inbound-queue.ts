import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/** Fila FIFO dedicada aos testes de integração do WagerTransactionConsumer —
 *  nunca a fila real (wager-transactions.fifo). VisibilityTimeout baixo
 *  (2s) torna redelivery/DLQ observáveis em segundos, não nos 30s padrão da
 *  fila de produção/dev. O consumer não sabe (nem precisa saber) que a fila
 *  é de teste — recebe apenas queueUrl. */

const TEST_QUEUE_NAME = 'wager-transactions-test.fifo';
const TEST_DLQ_NAME = 'wager-transactions-test-dlq.fifo';
const TEST_VISIBILITY_TIMEOUT_SECONDS = 2;
const TEST_MAX_RECEIVE_COUNT = 3;

function client(): SQSClient {
  return new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.SQS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

async function createFifoQueue(sqs: SQSClient, name: string, attributes: Record<string, string> = {}): Promise<string> {
  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true', ...attributes },
    }),
  );
  if (!result.QueueUrl) throw new Error(`CreateQueueCommand for "${name}" did not return a QueueUrl.`);
  return result.QueueUrl;
}

async function getQueueArn(sqs: SQSClient, queueUrl: string): Promise<string> {
  const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
  const arn = result.Attributes?.QueueArn;
  if (!arn) throw new Error(`GetQueueAttributesCommand for "${queueUrl}" did not return a QueueArn.`);
  return arn;
}

export async function setupTestInboundQueue(): Promise<{ queueUrl: string; dlqUrl: string; maxReceiveCount: number }> {
  const sqs = client();

  const dlqUrl = await createFifoQueue(sqs, TEST_DLQ_NAME);
  const dlqArn = await getQueueArn(sqs, dlqUrl);

  const queueUrl = await createFifoQueue(sqs, TEST_QUEUE_NAME, {
    VisibilityTimeout: String(TEST_VISIBILITY_TIMEOUT_SECONDS),
  });

  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        VisibilityTimeout: String(TEST_VISIBILITY_TIMEOUT_SECONDS),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(TEST_MAX_RECEIVE_COUNT),
        }),
      },
    }),
  );

  return { queueUrl, dlqUrl, maxReceiveCount: TEST_MAX_RECEIVE_COUNT };
}
