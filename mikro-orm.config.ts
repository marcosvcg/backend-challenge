import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  user: process.env.DATABASE_USER ?? 'junglegaming',
  password: process.env.DATABASE_PASSWORD ?? 'junglegaming',
  dbName: process.env.DATABASE_NAME ?? 'junglegaming',
  entities: ['./src/**/*.schema.ts'],
  extensions: [Migrator],
  migrations: {
    path: './src/migrations',
    glob: '!(*.d).{js,ts}',
  },
  debug: false,
});
