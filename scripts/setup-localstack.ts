import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';

/** Provisiona a infraestrutura SQS no LocalStack — 4 filas + 2 redrive policies.
 *  Idempotente: CreateQueue com os mesmos atributos não falha se a fila já
 *  existir; SetQueueAttributes sempre reaplica a redrive policy. O
 *  publisher/consumer NUNCA criam infraestrutura — só operam sobre filas que
 *  já existem (mesmo espírito das migrations do Postgres: infraestrutura
 *  declarada e aplicada explicitamente).
 *
 *  Duas filas distintas, deliberadamente separadas (decisão nossa, não
 *  imposta pelo README):
 *  - wager-transactions.fifo / -dlq: ENTRADA — onde providers publicam
 *    WagerTransactionRequested (seção 10 do README), consumida pelo futuro
 *    SQS consumer que chama ProcessWagerTransactionUseCase.
 *  - wager-events.fifo / -dlq: SAÍDA — onde o Outbox Publisher publica os
 *    eventos de integração (WagerTransactionProcessed, WalletBalanceChanged,
 *    etc., seção 11 do README). Nunca a mesma fila da entrada — são
 *    conceitos de transporte completamente diferentes (comando recebido vs.
 *    evento de domínio publicado). */

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.SQS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

const INBOUND_QUEUE_NAME = 'wager-transactions.fifo';
const INBOUND_DLQ_NAME = 'wager-transactions-dlq.fifo';
const OUTBOUND_QUEUE_NAME = 'wager-events.fifo';
const OUTBOUND_DLQ_NAME = 'wager-events-dlq.fifo';
const MAX_RECEIVE_COUNT = 5;

async function createFifoQueue(name: string, extraAttributes: Record<string, string> = {}): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        ...extraAttributes,
      },
    }),
  );
  if (!result.QueueUrl) {
    throw new Error(`CreateQueueCommand for "${name}" did not return a QueueUrl.`);
  }
  return result.QueueUrl;
}

async function getQueueArn(queueUrl: string): Promise<string> {
  const result = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = result.Attributes?.QueueArn;
  if (!arn) {
    throw new Error(`GetQueueAttributesCommand for "${queueUrl}" did not return a QueueArn.`);
  }
  return arn;
}

async function setupQueuePair(queueName: string, dlqName: string): Promise<{ queueUrl: string; dlqUrl: string }> {
  const dlqUrl = await createFifoQueue(dlqName);
  const dlqArn = await getQueueArn(dlqUrl);

  const queueUrl = await createFifoQueue(queueName);

  // SetQueueAttributes é sempre reaplicado — idempotente por natureza (não é
  // um "criar se não existir", é "garantir que estas Attributes estão assim").
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(MAX_RECEIVE_COUNT),
        }),
      },
    }),
  );

  return { queueUrl, dlqUrl };
}

export async function setupLocalstack(): Promise<{
  inbound: { queueUrl: string; dlqUrl: string };
  outbound: { queueUrl: string; dlqUrl: string };
}> {
  const inbound = await setupQueuePair(INBOUND_QUEUE_NAME, INBOUND_DLQ_NAME);
  const outbound = await setupQueuePair(OUTBOUND_QUEUE_NAME, OUTBOUND_DLQ_NAME);
  return { inbound, outbound };
}

if (import.meta.main) {
  setupLocalstack()
    .then(({ inbound, outbound }) => {
      console.log(`Inbound queue ready:  ${inbound.queueUrl}`);
      console.log(`Inbound DLQ ready:    ${inbound.dlqUrl}`);
      console.log(`Outbound queue ready: ${outbound.queueUrl}`);
      console.log(`Outbound DLQ ready:   ${outbound.dlqUrl}`);
    })
    .catch((err) => {
      console.error('Failed to set up LocalStack SQS infrastructure:', err);
      process.exit(1);
    });
}
