import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  private readonly sqsClient = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.SQS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  constructor(private readonly orm: MikroORM) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [postgresOk, sqsOk] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);

    if (!postgresOk || !sqsOk) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        postgres: postgresOk,
        sqs: sqsOk,
      });
    }

    return { status: 'ok', postgres: true, sqs: true };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      return await this.orm.isConnected();
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    try {
      await this.sqsClient.send(new ListQueuesCommand({}));
      return true;
    } catch {
      return false;
    }
  }
}
