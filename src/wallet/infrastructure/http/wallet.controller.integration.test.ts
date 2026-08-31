import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MikroORM, RequestContext } from '@mikro-orm/postgresql';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../app.module';
import { truncateAllTables } from '../../../shared/__test-support__/test-orm';

/** Sobe a AppModule real (mesma composition root de produção: MikroOrmModule,
 *  SharedModule, WalletModule, ValidationPipe global, DomainErrorFilter
 *  global) contra o Postgres real do docker-compose — não reconstrói módulos
 *  à mão, então qualquer regressão de wiring (token de DI errado, provider
 *  faltando) aparece aqui exatamente como apareceria em produção. Alvo:
 *  contrato HTTP → ValidationPipe → controller → DI/composition root →
 *  use case → query repository → Postgres, nunca as regras de domínio em si
 *  (essas já têm cobertura própria em wallet.test.ts/create-wallet.*). */
describe('WalletController — integration (real Nest app, real Postgres)', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    // Deliberadamente SEM app.useGlobalPipes()/useGlobalFilters() manuais aqui:
    // AppModule já registra ValidationPipe/DomainErrorFilter via APP_PIPE/
    // APP_FILTER. Fixar de novo neste setup mascararia uma regressão real —
    // se um dia app.module.ts parar de registrar um dos dois, este teste
    // deve falhar, não silenciosamente continuar testando um pipe/filter que
    // o teste mesmo recriou.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    orm = moduleRef.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables(orm);
  });

  function newPlayerId(): string {
    return randomUUID();
  }

  it('POST /wallets with a valid payload returns 201 and the expected response shape', async () => {
    const playerId = newPlayerId();

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 2, // Wallet.open() nasce version=1; o crédito de abertura incrementa para 2
    });
  });

  it('GET /wallets/:walletId returns 200 for a wallet that exists', async () => {
    const playerId = newPlayerId();
    const created = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '42.50', currency: 'BRL' } })
      .expect(201);

    const response = await request(app.getHttpServer()).get(`/wallets/${created.body.id}`).expect(200);

    expect(response.body).toEqual({
      id: created.body.id,
      playerId,
      balance: { amount: '42.50', currency: 'BRL' },
      version: 2,
    });
  });

  it('GET /wallets/:walletId returns 404 for a well-formed id that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get(`/wallets/${randomUUID()}`)
      .expect(404);

    expect(response.body.statusCode).toBe(404);
  });

  it('GET /wallets/:walletId returns 400 for a malformed id (not a UUID)', async () => {
    const response = await request(app.getHttpServer()).get('/wallets/not-a-uuid').expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('POST /wallets returns 409 for a duplicate playerId + currency', async () => {
    const playerId = newPlayerId();
    await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } })
      .expect(201);

    const conflict = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } })
      .expect(409);

    expect(conflict.body.statusCode).toBe(409);
  });

  it('POST /wallets rejects a negative amount in initialBalance with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: newPlayerId(), initialBalance: { amount: '-10.00', currency: 'BRL' } })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('POST /wallets rejects unknown extra fields with 400 (forbidNonWhitelisted)', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: newPlayerId(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
        somethingUnexpected: 'should be rejected',
      })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('concurrent GETs across different wallets never mix data (no Identity Map leakage)', async () => {
    const wallets = await Promise.all(
      [1, 2, 3].map(async (i) => {
        const playerId = newPlayerId();
        const created = await request(app.getHttpServer())
          .post('/wallets')
          .send({ playerId, initialBalance: { amount: `${i * 100}.00`, currency: 'BRL' } })
          .expect(201);
        return { id: created.body.id, playerId, amount: `${i * 100}.00` };
      }),
    );

    // 10 rodadas x 3 wallets = 30 GETs concorrentes, intercalados — se algum
    // fork vazasse identidade entre requests, alguma resposta traria o id/saldo
    // de outra wallet da rajada.
    const rounds = Array.from({ length: 10 }, (_, round) => round);
    const responses = await Promise.all(
      rounds.flatMap((round) =>
        wallets.map((w) =>
          request(app.getHttpServer())
            .get(`/wallets/${w.id}`)
            .expect(200)
            .then((res) => ({ round, expected: w, actual: res.body })),
        ),
      ),
    );

    for (const { round, expected, actual } of responses) {
      expect(actual.id).toBe(expected.id);
      expect(actual.playerId).toBe(expected.playerId);
      expect(actual.balance.amount).toBe(expected.amount);
      void round; // só para mensagem de falha legível se algum expect acima quebrar
    }
  });

  it('GET /wallets/:walletId resolves correctly with no ambient RequestContext active (fork-per-operation, not middleware-dependent)', async () => {
    // Evidência adicional, não a prova principal — essa é a combinação de:
    // AppModule não importar MikroOrmModule.forMiddleware(), o GET acima
    // funcionar (200), e as leituras concorrentes permanecerem isoladas.
    // Esta asserção só reforça que nenhum RequestContext ficou ativo durante
    // o request, coerente com fork-per-operation em vez de contexto ambiente.
    expect(RequestContext.currentRequestContext()).toBeUndefined();

    const playerId = newPlayerId();
    const created = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '5.00', currency: 'BRL' } })
      .expect(201);

    expect(RequestContext.currentRequestContext()).toBeUndefined();

    await request(app.getHttpServer()).get(`/wallets/${created.body.id}`).expect(200);

    expect(RequestContext.currentRequestContext()).toBeUndefined();
  });
});
