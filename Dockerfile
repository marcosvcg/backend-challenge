# oven/bun:1 (Debian-based), NUNCA oven/bun:1-alpine: o binário CLI do
# MikroORM (node_modules/.bin/mikro-orm-esm, usado pelo serviço `migrate` do
# docker-compose) tem shebang `#!/usr/bin/env -S node --loader ts-node/esm ...`
# — a flag `env -S` (múltiplos argumentos) só existe no GNU coreutils `env`,
# não no BusyBox `env` do Alpine. Confirmado empiricamente rodando o comando
# de migração dentro de ambas as imagens antes de decidir (ARCHITECTURE.md).
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "src/main.ts"]
