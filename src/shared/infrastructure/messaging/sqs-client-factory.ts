import { SQSClient } from '@aws-sdk/client-sqs';

/** Único ponto de construção de SQSClient de produção — mesma configuração
 *  (endpoint/region/credentials) que já era repetida ad-hoc em cada lugar
 *  que precisava de um client (HealthController, scripts, testes). Lido só
 *  quando efetivamente chamado — nunca em import time. */
export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.SQS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}
