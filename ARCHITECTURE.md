# ARCHITECTURE.md

> Documento vivo. Registra as decisões técnicas tomadas durante o desenvolvimento do desafio, o contexto/trade-off de cada uma e o motivo da escolha. Atualizado incrementalmente conforme o projeto avança — decisões ainda não tomadas não aparecem aqui.

---

## 1. Estrutura de módulos — feature-first

**Decisão:** organização por bounded context (feature folder), não por camada horizontal.

```
src/
├── wallet/         (domain / application / infrastructure)
├── wagering/       (domain / application / infrastructure)
├── inbox/          (transversal — dedupe de mensagens de fila)
├── outbox/         (transversal — publicação confiável de eventos)
├── shared/         (IntegrationEvent base, canonical JSON, erros base)
├── health/
└── main.ts
```

Cada módulo de negócio (`wallet`, `wagering`) tem internamente:

```
<modulo>/
├── domain/          # puro — sem ORM, sem decorators, sem framework
├── application/     # use cases + ports (interfaces) — sem infra
└── infrastructure/  # adapters: persistência, HTTP, mensageria
```

**Por quê:** o README descreve o domínio como conceitos de primeira classe (Wallet, Wagering, Ledger, Inbox, Outbox) — mapear a estrutura de pastas 1:1 com isso facilita navegação, revisão e explicação em entrevista. Uma alternativa (camadas horizontais `domain/`, `application/`, `infrastructure/` na raiz, contendo todos os agregados) foi descartada por gerar mais fricção de navegação sem ganho de pontuação — a régua de avaliação pede "boundaries" e "simplicidade" no mesmo critério (10 pts).

**Regras de dependência (sentido único):**
1. `domain` não importa nada de `application`/`infrastructure` nem de ORM/Nest. Só depende de `shared/domain` e libs puras (ex.: Decimal).
2. `application` depende só de `domain` do próprio módulo + `ports` (interfaces) de outros módulos — nunca de `infrastructure` concreta, nem do próprio módulo.
3. `infrastructure` implementa as `ports` de `application` e conhece `domain` (para rehydrate/serializar) — nunca o inverso.
4. Comunicação entre módulos só via `ports`, nunca importando classe concreta de outro módulo.
5. `wagering` pode depender de `wallet`, `inbox` e `outbox` (via ports). O inverso nunca ocorre — `wallet`/`inbox`/`outbox` não conhecem `wagering`.
6. `inbox` e `outbox` não dependem de nenhum módulo de negócio — são utilitários de infraestrutura confiável.

**Ledger não é módulo próprio:** `WalletLedgerEntry` vive em `wallet/domain`, pois só existe como efeito colateral de mudança de saldo — não tem ciclo de vida independente da `Wallet`.

---

## 2. HTTP e SQS compartilham o mesmo use case

**Decisão:** `ProcessWagerTransactionUseCase` (em `wagering/application`) é chamado tanto pelo controller HTTP quanto pelo consumer SQS. Não existem dois fluxos de regra de negócio.

**Diferença entre as duas entradas fica só na borda:**
- HTTP: resolve `Idempotency-Key` (header) antes de chamar o use case, serializa resposta/status depois.
- SQS: `tryClaim` no Inbox acontece dentro da própria transação do use case (ver seção 4); ack só após commit.

**Por quê:** evita duplicar regra de negócio entre dois caminhos de entrada, requisito reforçado pela seção 10 do README.

---

## 3. Transação atômica via UnitOfWork/TransactionRunner

**Problema a resolver:** Wallet, WagerTransaction, Ledger, Inbox e Outbox precisam ser persistidos na mesma transação SQL — sem isso, cai no cenário eliminatório "saldo atualizado mas evento perdido" ou double-debit.

**Decisão:** o use case não recebe repositórios individuais injetados. Recebe apenas um `TransactionRunner`, cuja única forma de uso é:

```ts
interface WageringUnitOfWork {
  wallet: WalletRepository;
  wagerTransaction: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

interface TransactionRunner {
  run<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T>;
}
```

Os repositórios concretos só existem dentro do `run()` — não há binding de DI global para eles, então não existe caminho de código onde um repositório escapa da transação.

**Quem abre a transação:** o próprio `ProcessWagerTransactionUseCase`, chamando `this.runner.run(...)`. Isso não viola a regra de camadas porque `TransactionRunner` é uma interface (porta) — o use case nunca importa `EntityManager` ou qualquer tipo do ORM. Controller e consumer apenas chamam `useCase.execute(cmd)` uma vez; não existe decorator `@Transactional()` na borda.

**Ledger não tem repositório próprio.** `WalletRepository` expõe `saveWithLedger(wallet, entry)` como operação atômica única (UPDATE wallet + INSERT ledger na mesma transação) — o use case nunca faz duas chamadas separadas para isso.

**Inbox: dedupe via INSERT atômico, não SELECT prévio.** `InboxRepository.tryClaim(consumerName, messageId, payloadHash)` faz `INSERT ... ON CONFLICT DO NOTHING` dentro da transação, apoiado em `UNIQUE(consumer_name, message_id)` no banco. Retorna `true` se este processo obteve o direito de processar, `false` se já existia (replay). Isso evita a corrida de duas entregas concorrentes da mesma mensagem passando por um SELECT prévio antes de qualquer uma commitar.

**Outbox Publisher (processo separado, fora da transação de negócio):** usa `SELECT ... FOR UPDATE SKIP LOCKED` em transação própria e curta (claim → publica no SQS → marca `published_at` → commit), garantindo que múltiplos publishers concorrentes nunca peguem a mesma linha. Publicação duplicada é aceitável — deve ser tratada de forma idempotente pelo consumidor rio abaixo.

**Teste obrigatório de prova (não apenas unitário com mocks):** integração com Postgres real forçando exceção deliberada entre dois dos inserts (ex.: depois de `wagerTransaction.save()`, antes de `outbox.enqueue()`) e verificando rollback completo de tudo — wallet, ledger, wagerTransaction e inbox inalterados.

---

## 4. ORM — MikroORM

**Decisão:** MikroORM, não TypeORM.

**Por quê (critério decisivo, não popularidade):** qual ORM torna mais difícil implementar errado a atomicidade Wallet+Ledger+Inbox+Outbox.

- No TypeORM, o caminho de menor resistência sob pressão de prazo é `@InjectRepository(Entity)` — que resolve um repositório **global, fora de qualquer transação**. É fácil usar esse atalho por hábito em vez do repositório transacional correto.
- No MikroORM, o padrão idiomático **já é** obter repositórios a partir do `EntityManager` corrente (fork da transação via `em.transactional()`) — não existe um atalho global equivalente tentador para código de escrita.
- `EntitySchema` (mapeamento sem decorators, necessário para manter o domínio puro) é suportado por ambos, mas é o caminho culturalmente mais natural e documentado no MikroORM.

**Trade-off aceito:** curva de aprendizado ligeiramente maior (conceito de Identity Map / fork do EntityManager) e comunidade menor que TypeORM. Considerado aceitável porque o conceito só precisa ser entendido uma vez (para escrever o `TransactionRunner`); o resto do código repositório-a-repositório é repetitivo.

**Padrões obrigatórios de uso do MikroORM neste projeto:**
- Modelos de persistência via `EntitySchema`, nunca decorators nas classes de domínio.
- Mappers explícitos (`toDomain(row)` / `toRow(entity)`) em cada repositório — sem conversão implícita/automática.
- Domínio é sempre criado/reidratado por factories estáticas (`Wallet.open`, `Wallet.rehydrate`, etc.) — construtor `private`/`protected`. Nenhum mapper usa `new Entity(...)` ou `Object.assign` para popular estado de domínio.
- Locking pessimista via `LockMode.PESSIMISTIC_WRITE` (equivalente a `SELECT ... FOR UPDATE`).
- Outbox claiming via QueryBuilder com `skipLocked: true`.

---

## 5. Biblioteca Decimal — `decimal.js`, com validação lexical própria

**Decisão:** `Money` usa `decimal.js` internamente, mas `decimal.js` **não é a validação de contrato** — é só o motor aritmético depois que a string já foi aceita.

**Fluxo de `Money.from({ amount, currency })`:**
1. **Validação lexical da string original**, antes de qualquer construção de `Decimal`:
   - rejeita string vazia;
   - rejeita notação científica (ex.: regex que aceita só `-?\d+\.\d{2}` ou equivalente, sem `e`/`E`);
   - rejeita mais ou menos de 2 casas decimais;
   - rejeita `NaN`/`Infinity` como texto;
   - rejeita negativos quando o contrato de entrada exigir não-negativo (seção 6.1 do README).
2. Só **depois** de passar na validação lexical é que a string é usada para construir o `Decimal` interno.
3. **Nenhum arredondamento silencioso** — se a string não representa exatamente um valor de escala 2, é erro de domínio, nunca um `.toFixed(2)`/`.round()` corretivo.

**Por quê:** confiar em `decimal.js` para "validar" aceitaria implicitamente formatos que a lib tolera (ex.: normalização automática, arredondamento ao construir com mais casas) mas que o README proíbe explicitamente. A validação de contrato é responsabilidade do domínio, não da biblioteca — a lib é só o motor aritmético depois que a entrada já é conhecida como válida.

**Encapsulamento do `Decimal`:** é **detalhe privado** de `Money` (`private readonly value: Decimal`). Nenhuma outra classe do domínio (`Wallet`, `WagerTransaction`, `WalletLedgerEntry` etc.) importa `decimal.js` ou manipula `Decimal` diretamente — toda interação com valores monetários passa pelos métodos públicos de `Money` (`add`, `subtract`, `isLessThan`, etc.), nunca acessando `.value` de fora.

---

## 6. Migrations — incrementais por conceito, nunca editadas após aplicadas

**Decisão:** uma migration por tabela/conceito, na ordem de dependência (ex.: `create_wallet`, `create_wager_transaction`, `create_wallet_ledger_entry`, `create_inbox_message`, `create_outbox_message`), cada uma já nascendo com as constraints essenciais daquela tabela (PK, UNIQUE, CHECK, FK, índices relevantes) — não uma migration monolítica "initial schema".

**Regras:**
- Alterações posteriores (novo índice, ajuste de constraint) entram em **novas** migrations — nunca editando uma migration já considerada aplicada.
- MikroORM CLI gera o SQL a partir do `EntitySchema`, mas **o SQL gerado é revisado manualmente** antes de aceitar a migration, especialmente para invariantes críticas (não-negatividade de saldo, unicidade de idempotência, imutabilidade do ledger).
- Quando o SQL gerado automaticamente não expressar a constraint corretamente (ex.: `CHECK` de saldo não-negativo, `UNIQUE` composto de idempotência), a migration é editada com **SQL manual**, não deixada para o código de aplicação garantir sozinho.

**Por quê:** o schema do banco é, segundo o próprio README (seção 5.9), o lugar onde as garantias críticas (unicidade, imutabilidade, não-negatividade) devem estar — não apenas em código. Migrations incrementais tornam essas revisões pontuais e isoladas, e evitam retrabalho confuso de reeditar uma migration gigante toda vez que uma constraint precisar de ajuste durante o desenvolvimento.

---

## 7. Schema do banco — tabela `wallet` (fechada)

```sql
CREATE TABLE wallet (
    id               UUID PRIMARY KEY,
    player_id        UUID NOT NULL,
    currency         VARCHAR(3) NOT NULL,
    balance_amount   NUMERIC(19, 2) NOT NULL,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT wallet_balance_nonneg CHECK (balance_amount >= 0),
    CONSTRAINT wallet_version_positive CHECK (version >= 1),
    CONSTRAINT wallet_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wallet_player_currency_unique UNIQUE (player_id, currency)
);
```

Nenhum índice adicional em `player_id` — `UNIQUE (player_id, currency)` já cria um índice composto cujo prefixo esquerdo é `player_id`, então buscas por `player_id` sozinho já se beneficiam dele. Índice dedicado só será adicionado se um padrão de query real justificar.

### Justificativa por constraint (requisito → constraint → teste que prova)

| Constraint | Requisito do README | Teste que prova eficácia |
|---|---|---|
| `NUMERIC(19,2)` | Seção 5.1 — proibido `number`/`float`/`double` para dinheiro; seção 6.1 — escala fixa de 2 casas na representação | **Não prova rejeição de escala** — Postgres arredonda/coage silenciosamente para a escala declarada em vez de rejeitar. A validação de "mais de 2 casas decimais é erro" é 100% responsabilidade de `Money.from()` (validação lexical antes de `decimal.js`, ver seção 5 deste documento), nunca da coluna. O que este tipo garante é só: armazenamento decimal exato (não binário/float) e um teto de escala para a aplicação já validada. |
| `CHECK (balance_amount >= 0)` | Seção 5 e 6.2 — saldo nunca negativo (invariante global, falha eliminatória se violada) | Teste de integração que tenta `UPDATE wallet SET balance_amount = -10.00` diretamente via SQL (bypassando a aplicação) e espera violação de CHECK — prova que a garantia não depende só do código de domínio. |
| `CHECK (version >= 1)` | Seção 6.2 — `version` inicia em 1 e incrementa somente quando o saldo muda | Teste de concorrência (cenário da seção 8) que dispara duas atualizações simultâneas na mesma wallet e verifica que a versão final é `version_inicial + 1`, nunca +2 — prova ausência de lost update na contagem. |
| `CHECK (currency ~ '^[A-Z]{3}$')` | Seção 6.1 — `currency` é código ISO-4217; embora o desafio possa assumir moeda única (BRL), o modelo continua multi-moeda | Teste de integração que tenta inserir `currency = 'brl'` ou `currency = 'BR'` diretamente via SQL e espera violação de CHECK — garante formato estrutural no banco independente de qualquer validação de aplicação. |
| `UNIQUE (player_id, currency)` | Seção 6.2 — no máximo uma wallet por `playerId`+`currency`; seção 9 — criar wallet duplicada deve falhar como conflito | Teste de integração que chama `POST /wallets` duas vezes **em paralelo** com mesmo `playerId`/`currency` e espera que só uma seja criada — prova que a unicidade vem da constraint (sem TOCTOU), não de um SELECT-then-INSERT na aplicação. |

`updated_at` é **INFERENCE** (não requisito explícito) — útil para auditoria/observabilidade, sugerido pelo próprio esqueleto de referência (`Wallet.updatedAt`).

---

## 8. Schema do banco — tabela `wallet_ledger_entry` (fechada)

> Ordem de criação nas migrations: esta tabela depende de `wager_transaction` já existir (FK `transaction_id`). A migration desta tabela nasce **depois** da migration de `wager_transaction`.

```sql
CREATE TABLE wallet_ledger_entry (
    id                UUID PRIMARY KEY,
    wallet_id         UUID NOT NULL REFERENCES wallet(id),
    transaction_id    UUID NOT NULL REFERENCES wager_transaction(id),
    direction         VARCHAR(6) NOT NULL,
    amount            NUMERIC(19, 2) NOT NULL,
    currency          VARCHAR(3) NOT NULL,
    balance_before    NUMERIC(19, 2) NOT NULL,
    balance_after     NUMERIC(19, 2) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
    CONSTRAINT ledger_amount_positive CHECK (amount > 0),
    CONSTRAINT ledger_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ledger_balance_before_nonneg CHECK (balance_before >= 0),
    CONSTRAINT ledger_balance_after_nonneg CHECK (balance_after >= 0),
    CONSTRAINT ledger_balance_arithmetic CHECK (
        (direction = 'DEBIT'  AND balance_after = balance_before - amount) OR
        (direction = 'CREDIT' AND balance_after = balance_before + amount)
    ),
    CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id)
);

CREATE INDEX ledger_wallet_id_created_at_id_idx
    ON wallet_ledger_entry (wallet_id, created_at, id);

-- Imutabilidade estrutural: nenhuma linha commitada pode ser alterada ou removida.
CREATE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'wallet_ledger_entry is immutable: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_ledger_entry_no_update
    BEFORE UPDATE ON wallet_ledger_entry
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER wallet_ledger_entry_no_delete
    BEFORE DELETE ON wallet_ledger_entry
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
```

### Justificativa por constraint

| Constraint | Requisito do README | Teste que prova eficácia |
|---|---|---|
| Trigger `BEFORE UPDATE/DELETE` | Seção 5.5 + 6.4 — imutabilidade "estrutural, não uma convenção"; seção 5.9 — garantia no schema | `UPDATE`/`DELETE` diretos via SQL (bypassando repositório) devem levantar exceção — prova que a imutabilidade sobrevive a bug de aplicação ou acesso SQL direto. `REVOKE UPDATE/DELETE` de role dedicada fica registrado como possível defense-in-depth futuro, não implementado agora para não introduzir complexidade de roles antes de fechar os P0. |
| `CHECK (direction IN ('DEBIT','CREDIT'))` | Seção 6.4 — enum `LedgerDirection` | Insert com valor fora do enum falha. |
| `CHECK (amount > 0)` | Seção 6.4 — valor é magnitude do movimento; direção carrega o sinal | Insert com `amount <= 0` falha — impede representar "não-movimento" (LOSS não gera ledger). |
| `CHECK (balance_before/after >= 0)` | Seção 6.2 — saldo nunca negativo, incluindo snapshots históricos | Insert com snapshot negativo falha. |
| `ledger_balance_arithmetic` | Seção 6.4 — `isBalanced()`: `balanceBefore ± money === balanceAfter`, "verificada na factory" | Insert com aritmética inconsistente falha — prova que a garantia existe também no banco, além da validação já feita na factory de domínio. |
| `UNIQUE (transaction_id, wallet_id)` | Seção 6.4 — no máximo um lançamento por wallet por transação | Insert de 2 entries para o mesmo par, inclusive sob concorrência/retry, deve rejeitar a segunda — protege contra duplo débito por redelivery no nível do ledger. |
| `FK transaction_id → wager_transaction(id)` | Integridade referencial | Insert com `transaction_id` inexistente falha. |
| Índice `(wallet_id, created_at, id)` | Seção 9 — `GET /wallets/:walletId/ledger?cursor=...` exige cursor estável e opaco | Teste de paginação com `created_at` colidente entre registros (alta concorrência) verifica que o cursor `(created_at, id)` nunca pula/repete — `id` desempata quando o timestamp colide. |
| `NUMERIC(19,2)` | Mesma ressalva da tabela `wallet` — não valida escala de entrada | `Money.from()` continua sendo o único responsável por rejeitar mais de 2 casas antes de qualquer persistência. |

---

## 9. Schema do banco — tabela `wager_transaction` (fechada)

```sql
CREATE TABLE wager_transaction (
    id                              UUID PRIMARY KEY,
    provider_id                     VARCHAR(64) NOT NULL,
    external_transaction_id         VARCHAR(128) NOT NULL,
    idempotency_key                 VARCHAR(191) NOT NULL,
    payload_hash                    VARCHAR(64) NOT NULL,
    wallet_id                       UUID NOT NULL REFERENCES wallet(id),
    player_id                       UUID NOT NULL,
    round_id                        VARCHAR(128) NOT NULL,
    game_id                         VARCHAR(128) NOT NULL,
    kind                            VARCHAR(16) NOT NULL,
    amount                          NUMERIC(19, 2) NOT NULL,
    currency                        VARCHAR(3) NOT NULL,

    reference_external_transaction_id  VARCHAR(128),
    reference_transaction_id           UUID REFERENCES wager_transaction(id),

    status                          VARCHAR(20) NOT NULL,
    failure_code                    VARCHAR(64),
    processed_at                    TIMESTAMPTZ,

    -- saldo observado no momento do veredito terminal — permite replay idempotente
    -- sem recalcular, mesmo depois que a wallet mudou (inclui LOSS/REJECTED, sem ledger)
    result_balance_amount           NUMERIC(19, 2),
    result_balance_currency         VARCHAR(3),

    -- retry com backoff para PENDING_REFERENCE (seção 7.1)
    reference_retry_attempts        INTEGER NOT NULL DEFAULT 0,
    next_reference_retry_at         TIMESTAMPTZ,

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT wt_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    CONSTRAINT wt_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),

    CONSTRAINT wt_amount_positive CHECK (amount > 0),
    CONSTRAINT wt_currency_format CHECK (currency ~ '^[A-Z]{3}$'),

    -- reference_external_transaction_id: obrigatória para REFUND/ROLLBACK,
    -- opcional para WIN, proibida para BET/LOSS/OPENING
    CONSTRAINT wt_reference_required_by_kind CHECK (
        (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
        OR (kind = 'WIN')
        OR (kind IN ('BET','LOSS','OPENING') AND reference_external_transaction_id IS NULL)
    ),

    -- reference_transaction_id (FK interna resolvida) só aplicável a REFUND, ROLLBACK, WIN
    CONSTRAINT wt_reference_transaction_only_when_applicable CHECK (
        reference_transaction_id IS NULL OR kind IN ('REFUND','ROLLBACK','WIN')
    ),

    -- PENDING_REFERENCE só válido para REFUND/ROLLBACK ainda não resolvidos
    CONSTRAINT wt_pending_reference_only_when_unresolved CHECK (
        (status = 'PENDING_REFERENCE' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NULL)
        OR (status <> 'PENDING_REFERENCE')
    ),

    -- OPENING é interno: sempre PROCESSED
    CONSTRAINT wt_opening_always_processed CHECK (
        kind <> 'OPENING' OR status = 'PROCESSED'
    ),

    -- processed_at exclusivo de PROCESSED (fiel ao esqueleto do README — sem coluna extra para outros terminais)
    CONSTRAINT wt_processed_at_only_when_processed CHECK (
        (status = 'PROCESSED' AND processed_at IS NOT NULL)
        OR (status <> 'PROCESSED' AND processed_at IS NULL)
    ),

    -- failure_code obrigatório em REJECTED/FAILED, proibido nos demais
    CONSTRAINT wt_failure_code_coherence CHECK (
        (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL)
        OR (status NOT IN ('REJECTED','FAILED') AND failure_code IS NULL)
    ),

    -- saldo resultante obrigatório em PROCESSED e REJECTED (inclui LOSS/REJECTED sem ledger).
    -- NULL para PENDING/PENDING_REFERENCE (sem veredito ainda) e para FAILED (erro permanente
    -- de infraestrutura pode ocorrer antes mesmo de um saldo confiável ter sido observado).
    CONSTRAINT wt_result_balance_currency_format CHECK (
        result_balance_currency IS NULL OR result_balance_currency ~ '^[A-Z]{3}$'
    ),
    CONSTRAINT wt_result_balance_coherence CHECK (
        (status IN ('PENDING','PENDING_REFERENCE','FAILED') AND result_balance_amount IS NULL AND result_balance_currency IS NULL)
        OR
        (status IN ('PROCESSED','REJECTED') AND result_balance_amount IS NOT NULL AND result_balance_currency IS NOT NULL)
    ),

    -- retry/backoff de PENDING_REFERENCE: next_reference_retry_at é obrigatório enquanto
    -- pendente (nenhuma referência pendente fica sem próxima execução agendada) e
    -- obrigatoriamente NULL fora desse estado. Sem limite máximo de attempts no schema —
    -- TTL/limite de tentativas é política configurável da aplicação.
    CONSTRAINT wt_reference_retry_attempts_nonneg CHECK (reference_retry_attempts >= 0),
    CONSTRAINT wt_next_retry_coherence CHECK (
        (status = 'PENDING_REFERENCE' AND next_reference_retry_at IS NOT NULL)
        OR (status <> 'PENDING_REFERENCE' AND next_reference_retry_at IS NULL)
    ),

    CONSTRAINT wt_idempotency_key_unique UNIQUE (idempotency_key),
    CONSTRAINT wt_provider_external_unique UNIQUE (provider_id, external_transaction_id)
);

-- Reversão única: uma referência não pode ser revertida duas vezes pelo mesmo tipo
CREATE UNIQUE INDEX wt_reference_reversal_unique
    ON wager_transaction (reference_transaction_id, kind)
    WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

-- Suporte ao worker de reprocessamento de PENDING_REFERENCE (seção 7.1) — ordenado
-- pelo próximo horário de retry, não por created_at, para respeitar o backoff
CREATE INDEX wt_pending_reference_worker_idx
    ON wager_transaction (next_reference_retry_at)
    WHERE status = 'PENDING_REFERENCE';
```

### Justificativa por constraint

| Constraint | Requisito | Teste que prova eficácia |
|---|---|---|
| `wt_kind_valid` / `wt_status_valid` | Seção 6.3 — enums | Insert com valor fora do enum falha |
| `wt_amount_positive` / `wt_currency_format` | Seção 6.1 — contrato de `Money` | Insert com `amount<=0` ou moeda mal formatada falha |
| `wt_reference_required_by_kind` | Seção 7.1/7.2 — REFUND/ROLLBACK exigem referência; WIN pode opcionalmente referenciar BET; BET/LOSS/OPENING nunca referenciam | Insert de `BET` com referência preenchida falha; insert de `REFUND` sem referência falha; `WIN` aceito com ou sem referência |
| `wt_reference_transaction_only_when_applicable` | Mesma lógica para a FK interna resolvida | Insert de `LOSS` com `reference_transaction_id` preenchido falha |
| `wt_pending_reference_only_when_unresolved` | Seção 6.3/7.1 — semântica de `PENDING_REFERENCE` | Insert contraditório (já resolvido mas ainda pendente) falha |
| `wt_opening_always_processed` | Seção 6.3 — `OPENING` é interno | Defesa em profundidade contra `OPENING` pendente |
| `wt_processed_at_only_when_processed` | Fidelidade ao esqueleto — `processed_at` só populado por `markProcessed` | Insert de `REJECTED` com `processed_at` falha; `PROCESSED` sem `processed_at` falha |
| `wt_failure_code_coherence` | Seção 7.2 — toda rejeição carrega `failureCode` | Insert de `REJECTED`/`FAILED` sem `failure_code` falha; `PROCESSED` com `failure_code` falha |
| `wt_result_balance_coherence` / `wt_result_balance_currency_format` | Seção 7 regra 7 — replay retorna "o resultado original, incluindo o saldo observado naquele momento" | Processar uma `BET`, mudar o saldo da wallet via outra transação, repetir a `BET` original (mesma idempotency key) — a resposta replay deve mostrar o saldo de quando a `BET` foi processada, não o saldo atual. Cobre `LOSS`/`REJECTED` (sem ledger): o saldo é lido da wallet no momento do veredito, não derivado do ledger. `FAILED` não exige saldo — erro permanente de infraestrutura pode ocorrer antes de qualquer leitura confiável de saldo |
| `wt_reference_retry_attempts_nonneg` / `wt_next_retry_coherence` | Seção 7.1 — backoff exponencial e limite de tentativas/TTL | Insert de `PENDING_REFERENCE` sem `next_reference_retry_at` falha — nenhuma referência pendente fica sem próxima execução agendada; insert de `PROCESSED`/`REJECTED`/etc. com `next_reference_retry_at` preenchido falha. Teste funcional: `next_reference_retry_at` no futuro impede o worker de tocar a linha antes do horário; `attempts` cresce monotonicamente a cada tentativa falha |
| `wt_idempotency_key_unique` | Seção 9 + teste obrigatório #1 (seção 13) — 50 requisições paralelas idênticas → 1 débito | 50 inserts concorrentes com mesma key: só 1 sucede, 49 batem em violação de UNIQUE — aplicação trata como replay |
| `wt_provider_external_unique` | Seção 9 — chave alternativa de consulta | Segunda camada contra duplicidade mesmo com keys de idempotência diferentes por engano |
| `wt_reference_reversal_unique` (índice único parcial) | Seção 7 regra 4 — reversão única pelo mesmo tipo de operação | Duas `REFUND` concorrentes para a mesma `BET`: só uma vira `PROCESSED`; a aplicação valida antes para gerar o `failureCode` correto, a constraint é a proteção final contra race |
| `wt_pending_reference_worker_idx` (índice parcial, por `next_reference_retry_at`) | Seção 7.1 — worker com backoff | Suporta varredura periódica sem table scan, respeitando o horário do próximo retry |

**Nota de escopo:** nenhuma trigger valida que a referência resolvida pertence ao mesmo provider/player/wallet/moeda/rodada (seção 7 regra 2) — isso é regra de domínio/aplicação, validada antes de resolver `reference_transaction_id`. A FK garante apenas que a referência existe, não que é "compatível"; validar compatibilidade no banco via trigger foi deliberadamente descartado por adicionar lógica procedural sem proteger uma invariante que a aplicação já não possa garantir com um lock/leitura na mesma transação.

---

## 10. Schema do banco — tabela `inbox_message` (fechada)

```sql
CREATE TABLE inbox_message (
    consumer_name    VARCHAR(64) NOT NULL,
    message_id       VARCHAR(191) NOT NULL,
    payload_hash     VARCHAR(64) NOT NULL,
    received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at     TIMESTAMPTZ,

    PRIMARY KEY (consumer_name, message_id)
);
```

### Justificativa

| Escolha | Requisito | Teste que prova eficácia |
|---|---|---|
| `PRIMARY KEY (consumer_name, message_id)` | Seção 10 — "deduplicar via inbox persistente por `(consumerName, messageId)`" | O use case tenta `INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING` dentro da mesma transação do processamento financeiro. Teste: enviar a mesma mensagem 50 vezes em paralelo (seção 13, teste #1, via SQS) — apenas 1 insert sucede; as outras 49 batem em conflito de PK e a aplicação trata como já-processada, sem tocar a wallet. |
| `payload_hash` | Detectar mensagem com o mesmo `messageId` mas conteúdo diferente (anomalia de transporte, não duplicata legítima) | Ver fluxo de redelivery abaixo. |
| Sem FK/coluna apontando para `wager_transaction` | O vínculo é indireto e por design: inbox e `wager_transaction` são gravados na **mesma transação atômica** (o `runner.run()` do use case); se um falhar, o outro reverte junto — não é uma FK que garante essa consistência, é a atomicidade da transação | — |

### Semântica de `processed_at` — corrigida

Como o `INSERT` do inbox acontece **dentro** da mesma transação SQL que debita a wallet, grava o ledger e enfileira o outbox, um crash **antes do commit** reverte tudo junto, inclusive o insert do inbox. Portanto, **neste desenho, uma linha de `inbox_message` commitada nunca fica com `processed_at = NULL`** — não existe um estado intermediário "reivindicado mas ainda processando" que sobrevive a um crash. `processed_at` é preenchido no mesmo instante em que a linha passa a existir de forma durável.

A coluna é mantida por fidelidade ao esqueleto do README (`InboxMessage.markProcessed(at)`) e para auditoria (quando a mensagem foi processada), mas **não existe uma máquina de recuperação dedicada para "processed_at NULL"** — esse estado não ocorre em operação normal deste desenho.

### Fluxo de redelivery (mensagem já processada)

Quando o consumer recebe uma mensagem cujo `(consumer_name, message_id)` já existe no inbox:

1. **`payload_hash` coincide** → redelivery legítima (at-least-once esperado). O consumer **não** executa novamente o use case financeiro — apenas confirma o `ack` ao SQS. Cobre diretamente o cenário "commit ocorreu, ack falhou, mensagem é reentregue" (teste obrigatório #5, seção 13).
2. **`payload_hash` diverge** → não é duplicata legítima, é conflito/anomalia de transporte (ex.: reuso indevido de `messageId` por outro payload). Tratado como falha permanente: log + métrica + política de DLQ, nunca reprocessado silenciosamente.

---

## 11. Schema do banco — tabela `outbox_message` (fechada)

```sql
CREATE TABLE outbox_message (
    id                UUID PRIMARY KEY,
    aggregate_id      UUID NOT NULL,
    event_type        VARCHAR(64) NOT NULL,
    payload           JSONB NOT NULL,
    occurred_at       TIMESTAMPTZ NOT NULL,

    attempts          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at      TIMESTAMPTZ,

    CONSTRAINT outbox_attempts_nonneg CHECK (attempts >= 0),

    -- published_at e next_attempt_at são mutuamente exclusivos: uma vez publicada,
    -- não há mais "próxima tentativa"
    CONSTRAINT outbox_next_attempt_coherence CHECK (
        (published_at IS NULL AND next_attempt_at IS NOT NULL)
        OR
        (published_at IS NOT NULL AND next_attempt_at IS NULL)
    )
);

-- Índice parcial: só mensagens pendentes/due, ordenadas por quando devem ser tentadas
CREATE INDEX outbox_pending_claim_idx
    ON outbox_message (next_attempt_at)
    WHERE published_at IS NULL;
```

### Justificativa por coluna/constraint

| Escolha | Requisito | Teste que prova eficácia |
|---|---|---|
| `id UUID PRIMARY KEY` | Seção 11 — `IntegrationEvent.eventId`; base da idempotência do consumidor final | Publicar a mesma linha duas vezes gera dois envios com o mesmo `eventId` — o consumidor deduplica por esse campo |
| `aggregate_id` | Seção 11 — `IntegrationEvent.aggregateId` | Query "eventos de uma wallet" filtra sem parsear `payload` |
| `event_type` | Seção 11 — tipo do evento "no tipo, não em string solta no call site" | Permite roteamento/observabilidade sem introspecção do JSON |
| `payload JSONB` | Seção 11 — envelope serializado, estável e versionável | Armazena o `toJSON()` completo, incluindo `version` |
| `occurred_at` | Seção 11 — momento de domínio do evento | Distinto de quando foi de fato publicado (`published_at`) |
| `attempts` + `CHECK (>= 0)` | Observabilidade (seção 12) — retries, outbox lag | Cresce a cada tentativa falha; métrica lê direto daqui |
| `next_attempt_at` (default `now()`) | Backoff exponencial do publisher | Mensagem recém-enfileirada já é elegível imediatamente; após falha, publisher recalcula para o futuro |
| `published_at` nullable | Marca sucesso definitivo da publicação | Uma vez preenchido, a linha sai do índice parcial de pendentes |
| `outbox_next_attempt_coherence` | Estado nunca ambíguo (pendente com retry agendado, XOR publicada) | Insert/update que deixe ambos NULL ou ambos preenchidos falha |
| `outbox_pending_claim_idx` (parcial, por `next_attempt_at`) | Publisher varre só pendentes e devidos, sem table scan | Ver claim concorrente abaixo |

### Claim concorrente entre múltiplos publishers

```sql
BEGIN;

SELECT id, aggregate_id, event_type, payload
FROM outbox_message
WHERE published_at IS NULL AND next_attempt_at <= now()
ORDER BY next_attempt_at
LIMIT :batch_size
FOR UPDATE SKIP LOCKED;

-- A transação PERMANECE ABERTA aqui. É durante esta janela, com os row locks
-- ainda ativos, que o publisher chama a API do SQS para cada linha do batch.
-- Se a transação commitasse antes deste ponto, os locks seriam liberados e
-- outro publisher concorrente poderia selecionar as MESMAS linhas antes da
-- publicação terminar — quebrando a exclusão que o SKIP LOCKED deveria garantir.

-- para cada linha do batch:
--   SQS.publish(linha)
--   sucesso            -> UPDATE ... SET published_at = now(), next_attempt_at = NULL WHERE id = linha.id
--   falha transitória  -> UPDATE ... SET attempts = attempts + 1,
--                          next_attempt_at = now() + backoff(attempts + 1) WHERE id = linha.id

COMMIT; -- só agora os locks são liberados
```

`FOR UPDATE SKIP LOCKED` faz cada publisher travar as linhas selecionadas e pular silenciosamente qualquer linha já travada por outro publisher concorrente. Dois publishers rodando o mesmo `SELECT` simultaneamente recebem conjuntos de linhas disjuntos.

**Trade-off assumido conscientemente:** a transação Postgres permanece aberta durante I/O de rede com o SQS — geralmente evitado, mas necessário aqui porque é exatamente o que preserva a exclusão mútua sem precisar de lease/ownership. Mitigação: `batch_size` pequeno, limitando quanto tempo cada transação fica aberta e quantas linhas ficam bloqueadas por vez.

**Caminho de falha explícito (por linha do batch):**

| Resultado da publicação | `published_at` | `next_attempt_at` | `attempts` |
|---|---|---|---|
| Sucesso | `now()` | `NULL` | inalterado |
| Falha transitória (timeout, erro de rede) | permanece `NULL` | `now() + backoff(attempts + 1)` | `attempts + 1` |

Ambos os ramos respeitam `outbox_next_attempt_coherence` (mutuamente exclusivos).

**`outbox_message.id` = `IntegrationEvent.eventId`:** nenhuma coluna extra — o `id` é o próprio `eventId` do envelope, gerado no momento em que o evento nasce no domínio/use case. Garante identificador estável entre tentativas de republicação da mesma linha, sem regenerar id a cada retry.

**Teste que prova:** dois publishers em paralelo sobre a mesma tabela — nenhuma linha publicada duas vezes por processos diferentes simultaneamente; soma de linhas processadas pelos dois é igual ao total pendente, sem sobreposição nem lacuna (seção 13, teste #6).

### Cenário: publicou no SQS, morreu antes de marcar `published_at`

Sequência: publisher lê a linha → chama a API do SQS e a mensagem **é entregue com sucesso** → processo morre antes do `UPDATE`/`COMMIT`. Como a transação nunca commitou, `published_at` continua `NULL` e o lock é liberado — na próxima varredura, a mesma linha volta a ser elegível e **será publicada de novo**.

**Isso é aceito deliberadamente, não é bug a corrigir**: a garantia deste sistema é *at-least-once*, não *exactly-once* (seção 3 do README já assume isso como premissa). Eliminar essa duplicação exigiria uma escrita atômica entre "publicar no SQS" e "marcar published_at no Postgres" — impossível sem 2PC entre dois sistemas diferentes, fora de escopo e desproporcional ao ganho. A responsabilidade de tornar a duplicação inofensiva é do **consumidor do evento**, que deduplica por `eventId` — simétrico ao padrão de Inbox já usado do lado de entrada.

**Escopo deliberadamente não incluído:** nenhuma coluna de lease/lock ownership/worker_id. `SKIP LOCKED` já resolve exclusão de claim entre publishers concorrentes sem precisar rastrear qual processo detém qual linha.

---

## 12. Estratégia de concorrência da wallet — pessimistic row lock (fechada)

**Decisão:** `SELECT ... FOR UPDATE` (MikroORM `LockMode.PESSIMISTIC_WRITE`) sobre a linha da `wallet`, mantido até o commit da mesma transação que grava `wallet` + `wallet_ledger_entry` + `wager_transaction` + `inbox_message` (quando aplicável) + `outbox_message`. Não combinamos com optimistic locking (`version` + retry) nem update atômico condicional — um único mecanismo de proteção é suficiente e mais simples de raciocinar/testar.

**Por que não optimistic locking + retry:** exigiria escrever, revisar e testar um laço de retry (quantas tentativas, comportamento no esgotamento) — superfície extra de bug (ex.: reler estado incorretamente, duplicar lançamento de ledger num retry mal feito) sem ganho relevante, já que a unidade de concorrência (seção 8 do README) é a própria `walletId`: duas apostas na mesma wallet precisam ser serializadas de qualquer forma, o lock só torna essa serialização explícita e gerenciada pelo banco em vez de implícita via corrida-e-retry na aplicação.

**Por que não update atômico condicional:** resolveria apenas o sub-caso trivial ("debitar se saldo suficiente" como uma única query), mas não cobre o fluxo real — `Wallet` como Aggregate Root aplica regras em memória (validação de moeda, cálculo de `balanceBefore`/`balanceAfter` para o ledger, decisão de kind) antes de persistir; adaptar isso a um `UPDATE ... WHERE` de uma linha exigiria reescrever a lógica de domínio já fechada ou convergir de volta para optimistic locking.

**Sobre contenção/throughput (correção de enquadramento):** o lock serializa transações que disputam a *mesma* wallet — isso não é eliminado nem é indesejável, é o comportamento correto do domínio. Não afirmamos ausência absoluta de fila/espera sob contenção extrema ("hot wallet"): esse é um risco operacional aceito como irrelevante para o volume de workload esperado neste desafio, não uma garantia de throughput ilimitado. Wallets diferentes continuam processadas em paralelo sem qualquer bloqueio cruzado.

**Papel de `wallet.version` (não é o mecanismo de locking):** `version` continua existindo e sendo mantida exatamente como o README define — inicia em `1` e **incrementa somente quando o saldo muda** (seção 6.2). Sua função aqui é **invariante de domínio e auditoria/observabilidade** (quantas vezes o saldo mudou), não proteção de concorrência — essa proteção vem inteiramente do `FOR UPDATE`.

**Repository — operação explícita, impossível de esquecer o lock:**

```ts
interface WalletRepository {
  findByIdForUpdate(id: string): Promise<Wallet>;   // único ponto de leitura no write path — sempre PESSIMISTIC_WRITE
  findById(id: string): Promise<Wallet | undefined>; // leitura simples, só para consultas (GET), nunca usada antes de mutar
  saveWithLedger(wallet: Wallet, entry: WalletLedgerEntry): Promise<void>;
}
```

`findByIdForUpdate` é a única forma de obter uma `Wallet` dentro do `ProcessWagerTransactionUseCase` (write path) — não existe atalho para ler a wallet "sem lock" nesse fluxo, o que torna esquecer o `PESSIMISTIC_WRITE` estruturalmente impossível, não apenas uma convenção. `findById` (sem lock) fica reservado exclusivamente às queries de leitura (`GET /wallets/:id`), que nunca mutam estado.

```ts
// infrastructure
async findByIdForUpdate(id: string): Promise<Wallet> {
  const row = await this.em.findOneOrFail(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
  return Wallet.rehydrate(toDomainProps(row));
}
```

O lock é adquirido nesta chamada e permanece ativo até o `COMMIT`/`ROLLBACK` do `em.transactional()` que envolve toda a operação (ver seção 3 deste documento) — nunca liberado antecipadamente.

### Testes que provam a estratégia

1. **Cenário obrigatório (seção 8):** duas `BET` de 80.00 concorrentes (`Promise.all` real) contra wallet com saldo 100.00 → exatamente uma `PROCESSED`, outra `REJECTED` por saldo insuficiente, saldo final 20.00, exatamente 1 `wallet_ledger_entry` de débito. Prova o **lock** (`FOR UPDATE`) serializando corretamente o acesso à mesma wallet.
2. **Teste obrigatório #1 (seção 13) — separado do teste de lock:** 50 requisições paralelas com a **mesma `Idempotency-Key`** → 1 único débito. Este teste prova a **constraint `UNIQUE(idempotency_key)`** (idempotência), não o lock pessimista — são réplicas da mesma operação, que nem deveriam chegar a competir pelo saldo; a maioria é barrada na camada de idempotência antes de qualquer `findByIdForUpdate`.
3. **Wallets distintas em paralelo (seção 13, teste #3):** sem degradação por lock cruzado — prova que o lock é por linha, não global.
4. **≥3 instâncias simultâneas (seção 13, teste #4):** repetir o cenário 1 com múltiplos processos apontando ao mesmo Postgres — prova que o lock funciona entre processos, não só entre requests do mesmo processo.
5. **Invariante final:** após qualquer teste acima, `wallet.balance == saldo reconstruído pelo ledger`.

---

## 13. Fluxo end-to-end de `ProcessWagerTransactionUseCase` (fechado — última decisão pré-código)

> Revisado após 4 correções de consistência (ver changelog ao final da seção): (1) `Wallet` não conhece `WagerTransactionKind` — quem decide débito/crédito é a lógica de wagering, que chama `wallet.debit()`/`wallet.credit()` diretamente; (2) finalização do Inbox centralizada num único ponto de saída, para nunca deixar `processed_at = NULL` num commit; (3) `PENDING_REFERENCE` é ACKable no transporte SQS mas **não é terminal** no domínio; (4) `WagerTransaction.create()` sempre nasce `PENDING`, e `markPendingReference()` transiciona e agenda o primeiro retry.

### Borda HTTP vs SQS (única diferença permitida)

```
HTTP Controller:
  1. Extrai Idempotency-Key do header (obrigatório)
  2. Monta ProcessWagerTransactionCommand { ..., origin: 'http', idempotencyKey }
  3. Chama useCase.execute(command)
  4. Mapeia resultado para status HTTP (Grupo E, decisão futura)

SQS Consumer:
  1. Recebe mensagem, extrai messageId e data (idempotencyKey já vem no payload)
  2. Monta ProcessWagerTransactionCommand { ..., origin: 'queue', messageId, consumerName, idempotencyKey }
  3. Chama useCase.execute(command)
  4. result.ackable === true  → ACK (cobre: processado, rejeitado, PENDING_REFERENCE persistido,
                                  conflito de idempotência, replay de redelivery já processada)
     result.ackable === false → não faz ACK (visibility timeout expira → redelivery →
       após maxReceiveCount, redrive policy da fila move para DLQ — único mecanismo de DLQ, sem publish manual)
```

A regra de negócio nunca se duplica entre as duas bordas — a diferença é só o que cada uma faz *antes* de chamar o use case e *depois* do retorno.

**Nomenclatura — `ackable` (transporte) ≠ `isTerminal()` (domínio):** um resultado é `ackable` quando o SQS pode confirmar a mensagem com segurança, porque a decisão sobre o que fazer a seguir já não é mais responsabilidade do redelivery da fila. Isso inclui `PENDING_REFERENCE`, que é `ackable = true` mas **não terminal** no domínio (`WagerTransaction.isTerminal()` continua `false` para ela) — o reprocessamento dessa transação passa a ser responsabilidade do worker agendado (seção 7.1 do README), não do SQS. Os dois conceitos vivem em objetos diferentes: `ackable` é propriedade de `ProcessWagerTransactionResult` (transporte/aplicação); `isTerminal()` é propriedade de `WagerTransaction` (domínio).

### Pseudocódigo do use case

```ts
async execute(cmd: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
  return this.runner.run(async (uow) => {

    // 1. INBOX — só quando origin === 'queue'. Guarda se este processo reivindicou
    //    a mensagem agora, para decidir no ÚNICO ponto de saída se marca processed_at.
    let inboxClaimed = false;
    if (cmd.origin === 'queue') {
      const claim = await uow.inbox.tryClaim(cmd.consumerName, cmd.messageId, cmd.payloadHash);
      if (!claim.isNew) {
        if (claim.payloadHashMatches) {
          return finish(ProcessWagerTransactionResult.alreadyAcked()); // redelivery legítima
        }
        return finish(ProcessWagerTransactionResult.permanentError('INBOX_PAYLOAD_MISMATCH'));
      }
      inboxClaimed = true;
    }

    // 2. IDEMPOTÊNCIA (idempotencyKey) — vale para HTTP e SQS igualmente
    const existing = await uow.wagerTransaction.findByIdempotencyKey(cmd.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== cmd.payloadHash) {
        // NÃO é veredito de negócio: nenhuma WagerTransaction nova é criada, nenhum
        // evento de domínio publicado. Conflito de protocolo de idempotência.
        // HTTP: 409. SQS: ACK (reprocessar não mudaria o resultado).
        return finish(ProcessWagerTransactionResult.idempotencyConflict(cmd.idempotencyKey));
      }
      return finish(ProcessWagerTransactionResult.replay(existing)); // resultado original, incl. saldo observado
    }

    // 3. RESOLVER REFERÊNCIA (REFUND/ROLLBACK obrigatório; WIN opcional)
    //    WagerTransaction.create() SEMPRE nasce PENDING (seção 6.3 do README).
    let referenceTransaction: WagerTransaction | undefined;
    let transaction = WagerTransaction.create(cmd); // status = PENDING

    if (cmd.referenceExternalTransactionId) {
      referenceTransaction = await uow.wagerTransaction.findByProviderAndExternalId(
        cmd.providerId, cmd.referenceExternalTransactionId,
      );
      const referenceRequired = cmd.kind === 'REFUND' || cmd.kind === 'ROLLBACK';
      if (!referenceTransaction && referenceRequired) {
        // Transiciona PENDING → PENDING_REFERENCE; o próprio método calcula e
        // preenche next_reference_retry_at (constraint wt_next_retry_coherence exige isso).
        transaction.markPendingReference();
        await uow.wagerTransaction.save(transaction);
        await uow.outbox.enqueue(WagerTransactionPendingReference.from(transaction));
        // ACKable (reprocessamento agora é do worker), mas NÃO terminal no domínio.
        return finish(ProcessWagerTransactionResult.pendingReference(transaction));
      }
    }

    // 4. LOCK NA WALLET — único ponto de leitura no write path (findByIdForUpdate)
    const wallet = await uow.wallet.findByIdForUpdate(cmd.walletId);

    // 5. REGRA DE NEGÓCIO — decidida pela lógica de WAGERING (não pela Wallet).
    //    Wallet não conhece BET/WIN/LOSS/REFUND/ROLLBACK — só sabe debitar/creditar
    //    e produzir o WalletLedgerEntry correspondente. Quem decide QUAL operação
    //    chamar, e SE ela move saldo, é esta camada, olhando cmd.kind.
    let outcome: WagerOutcome;
    try {
      if (transactionMovesDebit(cmd.kind)) {
        const { wallet: updatedWallet, ledgerEntry } = wallet.debit(cmd.money);
        transaction.markProcessed(referenceTransaction?.id, now());
        outcome = { wallet: updatedWallet, ledgerEntry, transaction };
      } else if (transactionMovesCredit(cmd.kind)) {
        const { wallet: updatedWallet, ledgerEntry } = wallet.credit(cmd.money);
        transaction.markProcessed(referenceTransaction?.id, now());
        outcome = { wallet: updatedWallet, ledgerEntry, transaction };
      } else {
        // LOSS: não move saldo, não gera ledger — apenas registra o resultado.
        transaction.markProcessed(referenceTransaction?.id, now());
        outcome = { wallet, ledgerEntry: undefined, transaction };
      }
    } catch (err) {
      // InsufficientBalanceError, DuplicateReversalError etc. — Wallet lança,
      // wagering traduz para REJECTED com o failureCode apropriado.
      transaction.reject(failureCodeFor(err));
      outcome = { wallet, ledgerEntry: undefined, transaction };
    }

    // 6. PERSISTE conforme o outcome
    if (outcome.ledgerEntry) {
      await uow.wallet.saveWithLedger(outcome.wallet, outcome.ledgerEntry);
    }
    await uow.wagerTransaction.save(outcome.transaction); // já com result_balance_* preenchido

    // 7. OUTBOX — sempre, para qualquer veredito terminal
    await uow.outbox.enqueue(buildEventFor(outcome));

    return finish(ProcessWagerTransactionResult.from(outcome)); // ackable = true

    // --- único ponto de saída: centraliza a finalização do Inbox ---
    async function finish(result: ProcessWagerTransactionResult): Promise<ProcessWagerTransactionResult> {
      if (inboxClaimed) {
        await uow.inbox.markProcessed(cmd.consumerName, cmd.messageId);
      }
      return result;
    }
  });
  // exceções não capturadas acima (infra: timeout, deadlock, erro de validação de schema)
  // propagam como transient ou permanent — ver classificação abaixo — e nunca fazem ACK
  // (o rollback da transação desfaz também o tryClaim do Inbox, então não há risco de
  // processed_at = NULL sobreviver a um commit)
}
```

Todas as etapas ocorrem dentro do **mesmo** `runner.run()` — um único commit ou rollback total (seção 3). A função interna `finish()` é o **único** lugar que chama `inbox.markProcessed()` — nenhum `return` do use case ocorre fora dela, o que torna esquecer a finalização do Inbox estruturalmente difícil, não apenas uma convenção a lembrar em cada ramo.

### Classificação de erros — três categorias, dois comportamentos de transporte

| Classificação | Exemplos | `ackable` | Transporte SQS |
|---|---|---|---|
| **Business/handled** | `PROCESSED`, `REJECTED` (saldo insuficiente, reversão duplicada), `PENDING_REFERENCE` persistido (não-terminal no domínio, mas handled no transporte), conflito de idempotência (payload divergente), replay de redelivery já processada | `true` | **ACK** — decisão já commitada, ou não há nada a commitar mas a decisão é definitiva para o transporte |
| **Transient** | Timeout de conexão com Postgres, deadlock detectado, erro de infraestrutura recuperável | `false` | **Não ACK** → visibility timeout expira → redelivery |
| **Permanent** | Payload malformado, `INBOX_PAYLOAD_MISMATCH`, erro de validação de schema | `false` | **Não ACK** → mesmo caminho do transient |

**Decisão deliberada de simplicidade:** transient e permanent seguem o **mesmo** caminho de transporte (não-ACK). Um único mecanismo operacional (`maxReceiveCount` + redrive policy da fila SQS) promove para a DLQ após esgotar as tentativas, para ambas as categorias. A distinção conceitual é mantida apenas para **logs estruturados e métricas**, não para criar um segundo caminho de código.

**Conflito de idempotência não é uma `WagerTransaction REJECTED`:** é detectado antes de qualquer criação de linha em `wager_transaction` — nenhum ledger, nenhum evento de domínio publicado. É `ackable` por ser um conflito de protocolo (mesma key, payload diferente nunca vai convergir com retry), não um veredito de regra de negócio do wagering.

### Changelog desta seção (correções de consistência pré-implementação)

1. **Removido `wallet.applyWagerTransaction(kind, ...)`.** `Wallet` não deve conhecer `WagerTransactionKind` — isso vazaria conceito de wagering para dentro do agregado de wallet. A lógica de wagering (etapa 5) decide, a partir de `cmd.kind`, se chama `wallet.debit(money)`, `wallet.credit(money)`, ou nenhum dos dois (LOSS). `Wallet` continua responsável apenas pelas invariantes financeiras (saldo não-negativo, moeda igual) e por produzir o `WalletLedgerEntry` consistente.
2. **Finalização do Inbox centralizada em `finish()`.** Antes, cada `return` antecipado (replay, conflito de idempotência) precisava lembrar de chamar `inbox.markProcessed()` individualmente — risco real de esquecer um ramo e commitar uma linha de Inbox com `processed_at = NULL`. Agora só existe um caminho de saída, que sempre decide a finalização a partir de `inboxClaimed`.
3. **`PENDING_REFERENCE` é `ackable`, não terminal.** Antes descrito ambiguamente como "business/terminal". Corrigido: é ACKable no transporte SQS (o worker agendado assume o reprocessamento), mas `WagerTransaction.isTerminal()` continua `false` para esse status — ela pode transicionar depois.
4. **`WagerTransaction.create()` sempre nasce `PENDING`.** A transição para `PENDING_REFERENCE` acontece via `markPendingReference()`, chamado explicitamente depois de constatar que a referência não existe — esse método é quem calcula e preenche `next_reference_retry_at`, nunca `create()` diretamente.

---

## 14. `Money.equals()` — assimetria deliberada com `add`/`subtract`/`isLessThan`

**Decisão:** `Money.equals(other)` retorna `false` quando as moedas diferem, em vez de lançar `CurrencyMismatchError`. Todas as demais operações binárias (`add`, `subtract`, `isLessThan`) continuam lançando o erro quando as moedas não coincidem.

**Por quê:** comparar por igualdade entre moedas diferentes é uma pergunta válida com resposta óbvia — dois valores de moedas diferentes nunca são iguais, isso não é uma tentativa inválida de misturar valores (diferente de somar/subtrair, que só faz sentido semântico entre valores da mesma moeda). Forçar `equals()` a lançar exigiria que todo chamador checasse a moeda manualmente antes de qualquer comparação, sem ganho de segurança real.

**Implementação:** `src/wallet/domain/money.ts` — `equals()` compara `currency` e `value` diretamente, sem passar por `assertSameCurrency()` (usado apenas por `add`, `subtract`, `isLessThan`).

---

## 15. `WagerBalanceEffect` — vocabulário próprio de wagering, não `LedgerDirection`

**Decisão:** `WagerTransaction` nunca importa `LedgerDirection` (que pertence exclusivamente a `wallet/domain`). Em vez disso, expõe `WagerBalanceEffect` (`DEBIT | CREDIT | NONE`), um enum próprio de `wagering/domain`. A camada de aplicação (ainda não implementada) traduz: `Debit → wallet.debit(...)`, `Credit → wallet.credit(...)`, `None → nenhuma chamada`.

**Por quê:** `wagering/domain` importar `LedgerDirection` de `wallet/domain` violaria na prática o boundary de módulos fechado na seção 1 — mesmo sendo um enum puro sem I/O, a regra de comunicação entre módulos existe para impedir acoplamento direto entre domínios de negócio distintos. Criar um `shared/domain/ledger-direction.ts` só para acomodar esse uso também foi descartado — moveria um conceito que pertence genuinamente à wallet só para satisfazer um consumidor externo, sem necessidade real de reuso por um terceiro módulo.

**Implementação:** `src/wagering/domain/wager-balance-effect.ts`. O método que devolve esse efeito chama-se `balanceEffectFor(reference?: WagerTransaction)` — nomeado assim (não `ledgerDirectionFor`, nome do esqueleto original do README) porque o tipo de retorno é `WagerBalanceEffect`, não `LedgerDirection`; manter o nome antigo teria sido uma inconsistência semântica.

**`ROLLBACK` não tem efeito próprio — inverte o da referência, com guarda explícita de kind válido:** `ROLLBACK` só pode reverter `BET`, `WIN` ou `REFUND` (seção 7 regra 3 do README). `balanceEffectFor()` valida isso explicitamente (`VALID_ROLLBACK_REFERENCE_KINDS`) e lança `InvalidReferenceKindError` se a referência for de outro kind (`ROLLBACK`, `LOSS` ou `OPENING`) — essa invariante não depende de nenhuma validação externa ter sido feita corretamente antes; é auto-contida na própria entidade.

---

## 16. `ProcessWagerTransactionUseCase` implementado — ports, geração de IDs/relógio, reversão duplicada, atomicidade provada com fakes

**Implementação real do fluxo fechado na seção 13.** Camada `application` completa: `WalletRepository`, `WagerTransactionRepository`, `InboxRepository`, `OutboxRepository` (ports), `TransactionRunner`/`WageringUnitOfWork`, `ProcessWagerTransactionCommand`/`Result`, e o use case em si — tudo sem qualquer import de MikroORM/NestJS (confirmado por grep).

**Geração de IDs e relógio — portas injetadas, não no `Command`:** `IdGenerator { newId(): string }` e `Clock { now(): Date }` (`shared/application/`) são injetados no use case. Descartamos pré-gerar IDs no `Command` porque o use case pode enfileirar mais de um evento por execução (ex.: `BET` processado gera `WagerTransactionProcessed` **e** `WalletBalanceChanged`, cada um com `eventId` próprio) — o caller não deveria precisar saber de antemão quantos IDs cada fluxo consome. `transactionId`, `ledgerEntryId` e todo `eventId` são gerados internamente pelo use case; `correlationId`/`causationId` continuam no `Command` por pertencerem ao contexto de entrada (propagados de header HTTP ou da mensagem SQS), não à geração interna.

**Reversão duplicada (seção 7 regra 4) — checada explicitamente na aplicação, não só pela constraint do banco:** `WagerTransactionRepository.hasProcessedReversal(referenceTransactionId, kind)` é chamado depois do lock pessimista da wallet e antes de qualquer `debit`/`credit`. Se já existe uma reversão `PROCESSED` do mesmo `kind` para a mesma referência, a transação é `REJECTED` com `DuplicateReversalError`/`resultBalance` = saldo atual, sem tocar a wallet. O índice único parcial `wt_reference_reversal_unique` (seção 9) continua como defesa final contra race — a checagem da aplicação existe para produzir o `failureCode` de negócio correto, não para substituí-la.

**`isKnownRejectionError` — catch restrito, nunca genérico:** a etapa 5 só traduz em `REJECTED` os erros de domínio explicitamente listados em `KNOWN_REJECTION_ERRORS` (`InsufficientBalanceError`, `InvalidReferenceKindError`, `DuplicateReversalError`). Qualquer outro erro (bug de programação, timeout, erro de tipo) **propaga** e provoca rollback da transação inteira — nunca é silenciosamente maquiado como rejeição de negócio. Descartamos um `catch (err) { if (err instanceof Error) return err.name }` genérico exatamente por essa razão: ele esconderia bugs reais atrás de uma resposta `REJECTED` aparentemente válida.

**`INITIAL_REFERENCE_RETRY_DELAY_MS` (30s) é provisório — não é a política de backoff.** Satisfaz apenas a obrigatoriedade de `next_reference_retry_at` ao entrar em `PENDING_REFERENCE` (constraint `wt_next_retry_coherence`, seção 9). A fórmula de backoff exponencial, o limite de tentativas/TTL e a transição final para `REJECTED` (seção 7.1 do README) são decisão formal do incremento do worker de `PENDING_REFERENCE` — deliberadamente não abertos agora.

### Bug encontrado e corrigido durante este incremento: fake de repositório mascarando quebra de atomicidade

O teste de rollback (`outbox.enqueue` falha após `wager_transaction.save()`) inicialmente **falhou** — não porque o use case estivesse errado, mas porque `FakeWalletRepository.findByIdForUpdate` devolvia a **mesma referência** de objeto que vivia em `committed`. Como `Wallet.debit()`/`credit()` mutam a instância recebida (decisão da seção 12), a wallet "committada" já ficava mutada por efeito colateral antes mesmo do rollback acontecer — `rollback()` limpava o `staged`, mas o dano já estava feito em `committed`.

**Correção:** `findByIdForUpdate` agora devolve uma cópia via `Wallet.rehydrate(...)`, nunca a referência viva — espelhando fielmente o que Postgres real faria (`SELECT FOR UPDATE` sempre materializa um objeto de domínio novo em memória). Isso é registrado aqui porque é exatamente o tipo de erro que a seção 8 do README pede para evitar: um teste que "passa" com mock/fake mas não prova a garantia real. O teste de atomicidade só ficou confiável depois desta correção.

### Testes cobertos (`process-wager-transaction.use-case.test.ts`, 12 casos)

BET processado (débito + 2 eventos); saldo insuficiente (rejeição sem mover saldo, sem `WalletBalanceChanged`); cenário obrigatório da seção 8 (duas BETs de 80 contra 100 → uma processada, uma rejeitada, saldo final 20); `LOSS` (sem ledger, sem mover saldo); `REFUND` sem referência (`PENDING_REFERENCE`, ackable e não-terminal); `WIN` referenciando `BET` processada; replay de idempotência; conflito de idempotência (payload divergente); dedupe via Inbox (redelivery legítima vs. `payloadHash` divergente); reversão duplicada; **prova de atomicidade via rollback forçado**.

---

## 17. Infraestrutura MikroORM — `EntitySchema` + mappers + migrations, validadas contra Postgres real

**`EntitySchema` por tabela, sem decorators no domínio:** `wallet.schema.ts`, `wager-transaction.schema.ts`, `wallet-ledger-entry.schema.ts`, `inbox-message.schema.ts`, `outbox-message.schema.ts` — cada um mapeando uma classe "burra" de linha (`*.row.ts`) para a tabela correspondente. Mappers explícitos (`*RowToDomain`/`*DomainToRow`) fazem a conversão, sempre via factory (`rehydrate`), nunca `new Entity()`/`Object.assign` no domínio.

**Migrations escritas manualmente, não geradas por diff automático.** Decisão confirmada durante este incremento: como praticamente toda invariante crítica deste projeto é uma `CHECK`, `UNIQUE` parcial ou trigger — nenhuma delas expressável a partir do `EntitySchema` sozinho — gerar o SQL automaticamente e editá-lo depois não traria economia real. As 5 migrations (`CreateWallet` → `CreateWagerTransaction` → `CreateWalletLedgerEntry` → `CreateInboxMessage` → `CreateOutboxMessage`, nessa ordem de dependência) foram escritas copiando exatamente o SQL já fechado nas seções 7-11 deste documento, com `up()`/`down()` completos e nomes de constraint/índice/trigger explícitos.

**Validação real contra Postgres, não apenas "a migration rodou sem erro":**
- As 5 migrations aplicadas com sucesso em sequência contra o container Postgres real.
- Reversibilidade comprovada: `migration:down` de `CreateOutboxMessage` de fato removeu a tabela (confirmado via `information_schema.tables`), e `migration:up` a restaurou.
- **Todas as 25 `CHECK` constraints e as 2 triggers de imutabilidade do ledger foram inspecionadas via `pg_constraint`/`pg_trigger`** — não apenas assumidas presentes.
- **6 invariantes críticas testadas funcionalmente** com inserts/updates/deletes reais via SQL direto (bypassando qualquer repositório): saldo negativo rejeitado, moeda mal formatada rejeitada, `UPDATE`/`DELETE` em ledger entry rejeitados pela trigger, aritmética de ledger inconsistente rejeitada, `idempotency_key` duplicada rejeitada.
- Ambiente resetado (`docker compose down -v` + `up -d` + reaplicar migrations) após os testes manuais, porque a própria trigger de imutabilidade impediu `DELETE` de limpeza — confirmação adicional (não intencional) de que a garantia não abre exceção nem para scripts administrativos.

**`schema:update --dump` do MikroORM usado só como sanity-check de drift, nunca como fonte de verdade — e nunca para ser aplicado.** Rodamos o dump e ele propôs **remover** todas as constraints/índices manuais (CHECKs, UNIQUEs compostas, índices parciais, FKs) e também **remover `DEFAULT`s de coluna** presentes nas migrations (ex.: `version default 1`, `attempts default 0`, `next_attempt_at default now()`) mas ausentes dos `EntitySchema`. Nenhum dos dois é drift acidental — é a lacuna esperada entre duas responsabilidades diferentes: **`EntitySchema` descreve apenas o mapeamento necessário para o MikroORM ler/escrever colunas (nome, tipo, nullability)**, nunca o DDL completo da tabela. `CHECK`, `UNIQUE` composta, índice parcial, trigger e `DEFAULT` são decisões de schema físico que vivem exclusivamente nas migrations — a fonte de verdade do banco — e são deliberadamente omitidas do `EntitySchema` porque o domínio/application já fornece esses valores explicitamente antes de persistir (`Wallet.open()` já define `version = 1`; `WagerTransaction.create()` já define `referenceRetryAttempts = 0`; o use case já passa `next_attempt_at` ao enfileirar na outbox) — não há necessidade de o ORM replicar um default que a aplicação nunca deixa de fornecer. Isso confirma a decisão: `schema:update` real **nunca deve ser executado neste projeto** — ele apagaria todas as garantias críticas do banco. O dump serve apenas para detectar divergência de tipo/nome/nullability de coluna entre `EntitySchema` e banco, nunca para decidir schema físico ou constraints de negócio.

**Nota de ambiente:** o CLI `@mikro-orm/cli` precisou ser fixado em `^6.4.0` (compatível com o restante dos pacotes MikroORM já instalados) — a versão mais recente (`7.x`) do CLI é incompatível com pacotes core `6.x` e falha o bootstrap com erro de versão. Rodar o CLI via `bun node_modules/@mikro-orm/cli/cli.js <comando> --config mikro-orm.config.ts` (não via `bunx`/binário `mikro-orm-esm`, que tem um shebang incompatível com o resolver de bin do Bun no Windows).

---

## 18. Repositórios concretos MikroORM + `MikroOrmTransactionRunner` — implementados e validados com testes de integração reais

**Nota sobre `src/migrations/.snapshot-<db>.json`:** artefato interno do MikroORM CLI (cache de estado do schema, usado por `migration:create` para calcular diffs). Versionado por decisão explícita — **não é fonte de verdade do schema** (as migrations manuais são) e **nunca deve justificar rodar `schema:update`** ou gerar constraints automaticamente a partir dele. Mantido como possível baseline para uma futura geração de migration por diff, caso o fluxo mude; se confirmarmos que o projeto seguirá exclusivamente com `migration:create --blank` até o fim, ele pode ser removido conscientemente mais tarde.

**As 4 garantias preservadas na implementação:**
1. Todos os 4 repositórios (`MikroOrmWalletRepository`, `MikroOrmWagerTransactionRepository`, `MikroOrmInboxRepository`, `MikroOrmOutboxRepository`) recebem o **mesmo `EntityManager` forked** no construtor — instanciados exclusivamente dentro de `MikroOrmTransactionRunner.run()`, nunca via DI global.
2. `findByIdForUpdate` usa `LockMode.PESSIMISTIC_WRITE` real (`em.findOneOrFail(WalletRow, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE })`) — gera `SELECT ... FOR UPDATE` de verdade.
3. `InboxRepository.tryClaim` é um `INSERT ... ON CONFLICT (consumerName, messageId) DO NOTHING` via QueryBuilder — nunca `SELECT` seguido de `INSERT`.
4. `hasProcessedReversal` roda depois do lock pessimista da wallet, dentro da mesma transação, exatamente na ordem que o use case já define (seção 16).

### Três bugs reais encontrados por testes de integração contra Postgres real (nenhum detectável com fakes/mocks)

**Bug 1 — `execute('all')` sem `.returning()` sempre retorna `[]`, mesmo em INSERT bem-sucedido.** Postgres só devolve linhas de um `INSERT` quando `RETURNING` é pedido explicitamente. O código inicial de `tryClaim` checava `insertedRows.length > 0` para decidir `isNew`, mas sem `.returning([...])` no QueryBuilder essa lista vinha sempre vazia — o teste de integração (não os testes unitários com fakes, que não simulam esse comportamento do driver) pegou isso imediatamente: o primeiro `tryClaim` de uma mensagem nova relatava `isNew: false` incorretamente. **Correção:** `.returning(['consumerName', 'messageId'])` adicionado à query. Confirmado com teste isolado fora do repositório antes de aplicar a correção, e com um teste de 50 `tryClaim` concorrentes reais provando `ON CONFLICT DO NOTHING` sob concorrência de fato (não apenas chamadas sequenciais).

**Bug 2 — ordem de escrita invertida entre `wagerTransaction.save()` e `wallet.saveWithLedger()` viola a FK `wallet_ledger_entry.transaction_id → wager_transaction.id`.** O use case (etapa 6, seção 13/16) chamava `saveWithLedger` antes de `wagerTransaction.save`. Isso nunca falhou com os fakes em memória do Incremento 5 (que não validam FK), mas contra Postgres real todo `BET` processado com sucesso falhava com `ForeignKeyConstraintViolationException` — mesmo dentro da mesma transação não commitada, o Postgres exige que a linha referenciada já tenha sido inserida (ainda que sem commit) antes do INSERT que a referencia. **Este era o bug mais sério dos três: quebrava o caminho feliz inteiro, não um edge case.** Corrigido invertendo a ordem: `wagerTransaction.save()` primeiro, `saveWithLedger()` depois — com comentário explícito no código apontando a FK como razão.

**Bug 3 (já registrado na seção 16) — fake de `WalletRepository` retornando referência viva em vez de cópia**, mascarando quebra de atomicidade nos testes unitários. Mencionado aqui de novo porque, junto aos Bugs 1 e 2, completa um padrão: **três defeitos reais em sequência, nenhum detectável sem Postgres real** — validando diretamente a decisão da seção 5 do README ("testes que substituem completamente PostgreSQL e SQS por mocks" é falha eliminatória) e a insistência do usuário em manter testes de integração reais desde o primeiro incremento de infraestrutura.

### Testes de integração implementados

- **`mikro-orm-inbox.repository.integration.test.ts`** (5 casos): claim novo, redelivery com payload igual/diferente, `markProcessed`, e **50 `tryClaim` concorrentes reais** para a mesma `(consumerName, messageId)` — exatamente 1 com `isNew: true`.
- **`process-wager-transaction.integration.test.ts`** (3 casos): BET end-to-end com wiring MikroORM completo (débito, ledger, `wager_transaction`, 2 eventos na outbox, todos com dados reais lidos de volta do Postgres); **prova de atomicidade** (falha forçada em `outbox.enqueue` reverte wallet + wager_transaction + outbox juntos); **lock pessimista sob concorrência real** — duas conexões (`orm.em.fork()`) distintas disputando a mesma wallet via `Promise.all`, provando exatamente um `PROCESSED`/um `REJECTED`, saldo final correto, e exatamente 1 ledger entry de débito (não 2).

**Reset de fixtures via `TRUNCATE ... CASCADE`** (helper `truncateAllTables`, `shared/__test-support__/test-orm.ts`) — usado exclusivamente em testes, nunca em código de produção. Diferente do incidente da seção 17 (onde a trigger de imutabilidade corretamente bloqueou um `DELETE` administrativo): `TRUNCATE` é o mecanismo padrão de reset de fixture em banco de teste descartável, e seu uso aqui não relaxa a garantia de imutabilidade em nenhum caminho de aplicação — a trigger continua ativa e testada.

**`UuidIdGenerator`** (`shared/__test-support__/`) substitui o `FakeIdGenerator` (sequencial, `id-1`/`id-2`) nos testes de integração — colunas `uuid` do Postgres rejeitam IDs que não sejam UUID válido, algo que os fakes em memória do Incremento 5 não validavam.

### Lacuna fechada: trigger de imutabilidade do ledger agora tem teste automatizado

A validação de `UPDATE`/`DELETE` rejeitados pela trigger (seção 8) havia sido feita apenas **manualmente**, via script ad-hoc, ao validar as migrations pela primeira vez — nunca virou parte da suíte `bun test`. Isso foi identificado como lacuna real (a garantia mais crítica de auditabilidade do ledger não tinha prova automatizada) e fechado com `wallet-ledger-entry-immutability.integration.test.ts` (4 casos): `UPDATE` via SQL direto rejeitado com a mensagem específica da trigger (`wallet_ledger_entry is immutable`, não uma constraint genérica); `DELETE` idem; e, para ambos, confirmação de que a linha permanece **intacta** após a tentativa rejeitada (não apenas que a query lançou erro). `TRUNCATE` (reset de fixture) e a asserção de imutabilidade são deliberadamente mantidos como responsabilidades separadas no arquivo — o primeiro só prepara o estado antes de cada teste, nunca participa da invariante sendo provada.