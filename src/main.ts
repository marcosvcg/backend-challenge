import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Necessário para que SIGTERM/SIGINT disparem OnApplicationShutdown em
  // qualquer provider que a implemente (WagerConsumerRuntime,
  // OutboxPublisherRuntime, PendingReferenceRuntime) — sem isto, o Nest nunca
  // escuta esses sinais e um shutdown gracioso nunca acontece
  // (ARCHITECTURE.md seção 30).
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
