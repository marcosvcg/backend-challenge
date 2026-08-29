import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { HealthModule } from './health/health.module';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), HealthModule],
})
export class AppModule {}
