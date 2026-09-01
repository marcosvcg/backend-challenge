import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/** Fila FIFO dedicada aos testes de integração do WagerTransactionConsumer —
 *  nunca a fila real (wager-transactions.fifo). VisibilityTimeout baixo
 *  (2s) torna redelivery/DLQ observáveis em segundos, não nos 30s padrão da
 *  fila de produção/dev. O consumer não sabe (nem precisa saber) que a fila
 *  é de teste — recebe apenas queueUrl.
 *
 *  Nomes de fila parametrizáveis (default preserva exatamente o par
 *  compartilhado original, `wager-transactions-test(-dlq).fifo`, usado pelo
 *  describe block pré-existente de redelivery/DLQ) — permite que um describe
 *  block diferente peça um PAR PRÓPRIO de fila/DLQ, isolado do compartilhado,
 *  sem duplicar a lógica de criação/redrive policy (hardening SQS: os testes
 *  de mensagens malformed nunca ACKam, então acumulariam na DLQ compartilhada
 *  ao longo de múltiplas execuções da suíte — uma fila dedicada evita
 *  poluir o describe block pré-existente que depende de pouco ruído na DLQ
 *  que consulta). */

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

export async function setupTestInboundQueue(
  queueName: string = TEST_QUEUE_NAME,
  dlqName: string = TEST_DLQ_NAME,
): Promise<{ queueUrl: string; dlqUrl: string; maxReceiveCount: number }> {
  const sqs = client();

  const dlqUrl = await createFifoQueue(sqs, dlqName);
  const dlqArn = await getQueueArn(sqs, dlqUrl);

  const queueUrl = await createFifoQueue(sqs, queueName, {
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

/** Remove um par fila/DLQ de teste dedicado — usado no afterAll de describe
 *  blocks que pedem recursos próprios (ver setupTestInboundQueue), para que
 *  cada execução da suíte comece com estado limpo nessa fila específica, sem
 *  tocar em nenhum recurso compartilhado com outros describe blocks. */
export async function teardownTestQueue(queueUrl: string, dlqUrl: string): Promise<void> {
  const sqs = client();
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
}
