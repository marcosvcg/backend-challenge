import { Module } from '@nestjs/common';
import { HealthController } from './infrastructure/health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
