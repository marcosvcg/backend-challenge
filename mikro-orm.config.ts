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
  // Nenhum *.schema.ts existe ainda neste incremento de setup (as entidades reais
  // chegam no próximo incremento). Sem isso, o MetadataDiscovery falha o bootstrap
  // por não encontrar nenhuma entidade — remover esta linha assim que o primeiro
  // schema (wallet) for criado.
  discovery: { warnWhenNoEntities: false, requireEntitiesArray: false },
  debug: false,
});
