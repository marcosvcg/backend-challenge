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

---

## 19. `CreateWalletUseCase` — orquestração real de `OPENING`, `TransactionRunner<TUnitOfWork>` genérico

**`TransactionRunner` generalizado.** Movido para `shared/application/transaction-runner.ts` como `TransactionRunner<TUnitOfWork>` — cada fluxo declara só o UoW que realmente usa. `WageringUnitOfWork` (4 repositórios, incl. inbox) continua servindo `ProcessWagerTransactionUseCase`; um novo `CreateWalletUnitOfWork` (3 repositórios — wallet, wagerTransaction, outbox, **sem** inbox) serve `CreateWalletUseCase`. O mecanismo por baixo (`em.transactional()`) é o mesmo para os dois — só muda o que `MikroOrmTransactionRunner`/`MikroOrmCreateWalletTransactionRunner` instancia dentro do `run()`.

**Identidade determinística da `OPENING`:** `providerId = 'internal'`, `externalTransactionId = idempotencyKey = "opening:${walletId}"` — no máximo uma `OPENING` por wallet, sem depender de payload de provider externo. `payloadHash` via `canonicalPayloadHash()` (novo helper em `shared/idempotency/`, JSON canônico + SHA-256, cinco testes unitários) sobre os campos que definem a operação (`kind`, `walletId`, `playerId`, `currency`, `amount`) — reaproveitado também pela idempotência HTTP real quando for implementada (seção 9 do README).

**Conflito de `(playerId, currency)` — nunca via `SELECT` prévio.** `WalletAlreadyExistsError` (novo, `wallet/domain/`) é lançado pelo repositório concreto ao traduzir `UniqueConstraintViolationException` do MikroORM, checando explicitamente que a constraint violada é `wallet_player_currency_unique` (qualquer outra violação de unicidade propaga como erro inesperado, não é silenciosamente tratada como conflito de negócio).

### Bug 4 (mesma família dos Bugs 1-3, seção 18): cadeia de FK de 3 níveis, não 2

A implementação inicial de `createWithLedger(wallet, entry)` tentava inserir `wallet` + `wallet_ledger_entry` juntos (corrigido primeiro para dois `flush()` separados), mas o teste de integração revelou uma segunda falha: `wallet_ledger_entry.transaction_id` também tem FK para `wager_transaction.id`, que ainda não existia. A cadeia real de dependência para `OPENING` é `wallet → wager_transaction → wallet_ledger_entry` — três níveis, não dois.

**Correção de design, não só de ordem:** em vez de encadear três `flush()` dentro de um método `createWithLedger` cada vez mais artificial, o método foi **removido**. `CreateWalletUseCase` agora:
1. `Wallet.open()` (saldo zero, version 1) → `uow.wallet.create(wallet)` — INSERT imediato, visível só dentro da transação.
2. Se `initialBalance.isZero()`, retorna aqui — nenhuma `OPENING`, nenhum ledger, nenhum evento (seção 6.4: operações sem efeito no saldo não geram lançamento).
3. Senão, constrói a `WagerTransaction` `OPENING`, aplica `wallet.credit(...)` em memória, `transaction.markProcessed(...)` — tudo ainda sem I/O.
4. `uow.wagerTransaction.save(transaction)` — a `wager_transaction` passa a existir.
5. `uow.wallet.saveWithLedger(wallet, ledgerEntry)` — **reaproveita o método já existente e já testado** (Incremento 6) que atualiza a wallet do saldo zero para o saldo final e insere o ledger entry, agora com a FK satisfeita.
6. Outbox: `WagerTransactionProcessed` + `WalletBalanceChanged`.

Isso eliminou a necessidade de qualquer método novo de "inserir ledger isolado" — `saveWithLedger` já fazia exatamente o que era preciso (`UPDATE` wallet + `INSERT` ledger), só faltava a wallet já existir como linha própria antes de chamá-lo. `WalletRepository` ficou com uma porta a menos (`create`, `findById`, `findByIdForUpdate`, `saveWithLedger`) do que teria com `createWithLedger` mantido.

### Testes de integração (`create-wallet.integration.test.ts`, 4 casos)

Saldo zero (sem `OPENING`, sem eventos); saldo positivo (`OPENING` `PROCESSED`, `providerId='internal'`, 1 ledger entry `CREDIT` balanceado, 2 eventos); **atomicidade** (falha forçada reverte wallet + `wager_transaction` + outbox juntos — nenhuma wallet órfã sobrevive); **concorrência real** (duas conexões distintas disputando o mesmo `playerId`+`currency` — exatamente 1 `created`, 1 `conflict`, nunca duas linhas na tabela `wallet`).

---

## 20. Ajustes pós-auditoria red-team do Incremento 7 — `WagerTransactionRepository.save()` dividido em `create()`/`update()`

A auditoria aprovou as garantias críticas do Incremento 7 (atomicidade, lock pessimista, tradução de conflito) e levantou um **risco plausível, não um bug já confirmado**: `WagerTransactionRepository.save()` fazia `findOne` + `assign` (update implícito) sempre que a linha já existia, usando `wagerTransactionDomainToRow` — um mapper que constrói o payload de update condicionalmente por campo. A hipótese era que `em.assign()` não zeraria uma coluna cuja chave estivesse ausente do objeto passado, deixando resíduo de um estado anterior (ex.: `next_reference_retry_at` sobrevivendo a uma transição `PENDING_REFERENCE → PROCESSED`).

**Investigação (antes de aceitar a correção como resolvendo um bug real):** escrito um teste de integração que exercita exatamente essa transição contra Postgres real. Ele passou mesmo usando o mapper antigo. Isolamento adicional (fora da suíte, via scripts ad-hoc) mostrou a causa: `wagerTransactionDomainToRow()` sempre retorna uma **instância de `new WagerTransactionRow()`**, e em TypeScript/Bun, campos de classe declarados com `?` mas nunca atribuídos já existem como **chaves próprias do objeto com valor `undefined`** — diferente de um objeto literal construído por spread condicional (`{...(x !== undefined ? {x} : {})}`), onde a chave de fato não existe. O MikroORM `assign()`, ao encontrar a chave presente com valor `undefined`, gera `SET coluna = NULL` no UPDATE — ou seja, **a coluna era zerada corretamente mesmo com o mapper antigo**. O padrão de omissão condicional por spread (que teria o bug real) existe no código, mas apenas em `wagerTransactionRowToDomain` (row → domínio), direção que nunca é passada para `assign()`.

**Decisão, mesmo com o risco não confirmado como manifestado:**
- `WagerTransactionRepository.save()` → `create()` (INSERT, sem `findOne` prévio) + `update()` (UPDATE de linha existente) **mantido** — separação semântica mais clara (INSERT nunca deveria pagar o custo de um SELECT prévio) e melhor intenção de leitura, independente do bug específico.
- Novo `wagerTransactionDomainToUpdatePayload()` no mapper — mapeia **todo** campo opcional explicitamente para `?? null` (`referenceExternalTransactionId`, `referenceTransactionId`, `failureCode`, `processedAt`, `resultBalanceAmount`/`Currency`, `nextReferenceRetryAt`), tipado como `EntityData<WagerTransactionRow>`. **Mantido deliberadamente** mesmo com a investigação mostrando que o comportamento incidental de class-fields já produzia o resultado correto — não é seguro depender dessa semântica implícita (ela é fácil de quebrar se o mapper de update um dia for reescrito para usar objeto literal, como o de leitura já faz), então o `null` explícito torna a intenção auditável no próprio código, não uma consequência acidental de como TS declara campos de classe.
- `wagerTransactionDomainToRow()` (usado só por `create()`) permanece com omissão condicional — correto ali, porque a linha é nova.
- Callers atualizados: `ProcessWagerTransactionUseCase` e `CreateWalletUseCase` sempre chamam `create()`. `update()` fica pronto para o worker de `PENDING_REFERENCE`, seu primeiro caller real.

**Teste de integração permanente** (`mikro-orm-wager-transaction.repository.integration.test.ts`, 2 casos): transição real `PENDING_REFERENCE → PROCESSED` via `update()`, provando contra Postgres que `next_reference_retry_at` vai de um timestamp real para `NULL` e `reference_transaction_id` vai de `NULL` para o valor correto — guarda permanente contra reintrodução do risco, não prova de que ele já havia se manifestado. Um segundo caso prova que `update()`/`create()` não apagam por engano campos que deveriam permanecer preenchidos (`failureCode`, `resultBalance` numa transação `REJECTED`).

**Teste de integração para a tradução de `WalletAlreadyExistsError`** (`mikro-orm-wallet.repository.integration.test.ts`, 2 casos, Postgres real): violação de `wallet_player_currency_unique` traduzida corretamente; violação de `wallet_pkey` (mesmo `id`, `playerId` diferente) **não** traduzida — propaga como `UniqueConstraintViolationException` pura, provando que a tradução é específica à constraint, não genérica para qualquer erro de unicidade.

**Deliberadamente não alterado nesta rodada** (confirmado pela auditoria, fora de escopo): número de `flush()` por operação (múltiplos round-trips na mesma transação, rollback já provado — otimizar isso fica para outro momento, se necessário); `version` continua sendo campo de domínio/auditoria, não mecanismo de concorrência — `PESSIMISTIC_WRITE` continua sendo a única proteção real, sem optimistic locking do MikroORM habilitado.

---

## 21. SQS Consumer — `WagerTransactionConsumer`, reutilizando o mesmo use case da entrada HTTP

**Fiel ao contrato fechado na seção 13**: o consumer monta `ProcessWagerTransactionCommand { origin: 'queue', ... }` e chama `ProcessWagerTransactionUseCase.execute()` — a mesma instância/classe que a futura entrada HTTP usará. `result.ackable` decide `DeleteMessage` (ACK) ou não-ACK; a regra de negócio nunca se duplica entre as duas bordas.

**Parsing estrutural separado da idempotência de negócio.** `parseWagerTransactionMessage()` valida o shape da mensagem (README seção 10) **antes** de qualquer tentativa de montar um `ProcessWagerTransactionCommand`. `MalformedWagerTransactionMessageError` (JSON inválido, campo obrigatório ausente, `kind` desconhecido ou `OPENING` — interno, nunca aceito da fila) é classificado como permanent, mas **nunca gera ACK manual nem uma `WagerTransaction REJECTED`** — a mensagem nem chegou a formar um comando válido para o domínio decidir sobre. Segue o mesmo caminho operacional de qualquer resultado não-ackable: sem ACK, redrive policy da fila move para DLQ após `maxReceiveCount` — um único mecanismo de DLQ, consistente com a decisão da seção 13.

**Três classificações conceituais, dois caminhos de transporte** (mesmo padrão da seção 13): `business/handled` (ACK) vs. `transient` e `permanent` (ambos não-ACK, diferindo só em log/métrica). Confirmado agora com um caminho real de código: exceções inesperadas do use case (timeout de Postgres, bug) e erros de parsing estrutural levam ao mesmo `DeleteMessageCommand` nunca sendo chamado.

**Processamento sequencial por poll**, não paralelo dentro do mesmo processo — `for...of` com `await`, no máximo uma mensagem em voo por vez. A concorrência relevante entre wallets continua vindo de múltiplas *instâncias* do consumer (processos), não de paralelismo interno; isso mantém o raciocínio sobre `SIGTERM`/graceful shutdown simples.

**Graceful shutdown (`stop()`)**: seta uma flag `stopping`, nunca inicia um novo `ReceiveMessageCommand` depois dela, e deixa a mensagem em voo (se houver) terminar normalmente antes de retornar — sem `ChangeMessageVisibility(0)` para interromper processamento em andamento (não exigido pelos requisitos deste incremento).

### Achado de design: `waitTimeSeconds` precisa ser configurável, não hardcoded

`stop()` só retorna depois que o `ReceiveMessageCommand` **em andamento** resolve — e como esse comando usa long polling (`WaitTimeSeconds`), um valor fixo de 10s (adequado para produção/dev, reduzindo custo de polling vazio) tornaria todo teste de graceful shutdown lento e sujeito a estourar timeouts do `bun test`. Corrigido tornando `waitTimeSeconds` um parâmetro do construtor (`WagerTransactionConsumer`), com default de 10s — os testes de integração passam `1`, tornando `stop()` rápido e determinístico sem mudar o comportamento de produção. Isso não foi uma mudança cosmética: a primeira versão dos testes falhava em cascata (um teste ainda "preso" dentro de `stop()` enquanto o `beforeEach` do próximo já truncava o banco) precisamente por essa razão.

### Achado de harness de teste: SQL bruto dentro de `em.transactional()` não participa da transação sem o contexto explícito

Ao escrever o teste "nunca publica antes do commit" (reaproveitado do incremento do Publisher) adaptado para este consumer, uma verificação usando `em.getConnection().execute(rawSql)` dentro de um callback `transactional()` mostrou uma linha sobrevivendo a um rollback forçado. Investigação isolada (fora da suíte) confirmou: `execute()` chamado diretamente numa conexão obtida via `getConnection()` **não** participa do `BEGIN`/`COMMIT`/`ROLLBACK` gerenciado internamente por `em.transactional()`, a menos que o `transactionContext` (`em.getTransactionContext()`) seja passado explicitamente como quarto argumento. Nunca afetou código de produção — todo repositório concreto sempre escreve via `em.create()`/`em.assign()`/`flush()`, que já respeitam esse contexto internamente. Documentado aqui porque é a segunda vez que esse padrão de teste (SQL bruto dentro de uma transação MikroORM) produz um resultado enganoso — vale lembrar antes de escrever um teste de isolamento transacional no futuro.

### Testes (17 unitários + 5 integração)

**`parse-wager-transaction-message.test.ts`** (12 casos): mensagem válida com/sem referência opcional; JSON inválido; array em vez de objeto; campos obrigatórios ausentes; `type` inesperado; `kind` inválido; `OPENING` explicitamente rejeitado; `money` ausente ou malformado.

**`wager-transaction.consumer.integration.test.ts`** (5 casos, Postgres + LocalStack reais, fila FIFO de teste dedicada com `VisibilityTimeout=2s`/`maxReceiveCount=3` — nunca a fila de produção): processa e ACKa uma mensagem válida (débito real, mensagem sai da fila); redelivery quando o use case falha transitoriamente (sem ACK, mensagem reaparece após o visibility timeout); mensagem move para a DLQ após esgotar `maxReceiveCount`; Inbox deduplica redelivery da mesma mensagem sem debitar duas vezes; `stop()` deixa a mensagem em voo terminar sem iniciar uma nova. Todas as asserções filtram por um identificador específico (`externalTransactionId`) em vez de assumir "a única mensagem da fila" — as filas de teste (principal e DLQ) acumulam mensagens de execuções anteriores da suíte, nunca são purgadas entre testes deste arquivo.

---

## 22. `ResolveAndApplyWagerTransaction` — extração para reuso entre o fluxo normal e o worker de `PENDING_REFERENCE`

**Motivação:** o worker de `PENDING_REFERENCE` (próximo incremento) precisa reexecutar exatamente a mesma etapa de "resolver referência → lock wallet → aplicar → persistir → outbox" que `ProcessWagerTransactionUseCase.execute()` já fazia inline — mas não pode simplesmente chamar `execute()` de novo (cairia no branch de replay de idempotência, já que a `WagerTransaction` `PENDING_REFERENCE` já existe) nem abrir uma segunda transação (quebraria a exigência de que claim + resolução + wallet lock + persistência sejam atômicos numa única transação). A solução: extrair as etapas 4-7 do use case original para `ResolveAndApplyWagerTransaction`, um serviço de aplicação compartilhado, chamado por ambos os callers **dentro** de suas respectivas transações já abertas.

**Assinatura:** `execute(ctx: ResolveAndApplyContext, uow: ResolveAndApplyUnitOfWork): Promise<ProcessWagerTransactionResult>`, onde `uow` é `{ wallet, wagerTransaction, outbox }` (sem `inbox` — nunca participa desta etapa) e `ctx` carrega `transaction`, `referenceTransaction?`, `correlationId`/`causationId`, e `persistenceMode: 'create' | 'update'`.

**`persistenceMode` é explícito no call site de cada caller, nunca inferido.** No fluxo normal (`ProcessWagerTransactionUseCase`), a transação ainda não existe no banco → `'create'`. No worker de `PENDING_REFERENCE`, a transação já existe como `PENDING_REFERENCE` → `'update'`. O serviço nunca consulta o banco ou o status da entidade para decidir isso — decidimos deliberadamente não persistir a `WagerTransaction` antecipadamente no fluxo normal só para unificar em um único caminho `update()`, porque isso adicionaria um flush intermediário desnecessário a um fluxo que já funciona.

**Nova invariante de domínio fechada nesta rodada: `WagerTransaction.assertCompatibleReference(reference)`** (seção 7 regras 2, 3, 5 do README) — validado uma única vez, reusado pelos dois callers. Cobre o que `balanceEffectFor()` não cobre: `reference.status === PROCESSED`; mesmo `providerId`/`playerId`/`walletId`/moeda/`roundId`; `REFUND` só referencia `BET` (mais restrito que `ROLLBACK`, que aceita `BET`/`WIN`/`REFUND`); valor exato igual ao da referência (reversão parcial fora de escopo). Essa validação **nunca tinha sido implementada** — a seção 9 registrava isso apenas como nota de escopo ("regra de domínio/aplicação a implementar depois"), e um `REFUND`/`ROLLBACK` cuja referência fosse resolvida na primeira tentativa (sem passar por `PENDING_REFERENCE`) não era validado. Corrigido agora, antes do worker, porque a mesma regra vale para os dois caminhos — nunca só para o mais recente.

**Novo erro de domínio:** `IncompatibleReferenceError` (`wagering.errors.ts`), adicionado a `KNOWN_REJECTION_ERRORS` — vira `REJECTED` com `failureCode: 'IncompatibleReferenceError'`, nunca propaga como erro inesperado.

**Testes:** 10 novos casos unitários de domínio (`wager-transaction.test.ts`) cobrindo cada dimensão de incompatibilidade isoladamente (provider, player, wallet, moeda, rodada, kind de referência, valor) e o caminho de aceitação; 1 novo teste de integração real (`process-wager-transaction.integration.test.ts`) provando, contra Postgres real, que uma `REFUND` com `roundId` incompatível é rejeitada sem mover saldo mesmo quando a referência é resolvida na primeira tentativa (não via worker).

## 23. `RetryPendingReferencesUseCase` — worker de recuperação de `PENDING_REFERENCE`

**Motivação:** fecha o fluxo de `REFUND`/`ROLLBACK` que chegam antes da transação referenciada (README seção 7.1). A transação fica em `PENDING_REFERENCE`; este worker roda periodicamente, tenta resolver a referência de novo e, dependendo do resultado, processa, reagenda ou rejeita — sem duplicar nenhuma regra financeira já fechada na seção 22.

**Peças novas:**
- `PendingReferenceWorkerRepository.claimBatch(batchSize, now)` — `SELECT ... WHERE status = 'PENDING_REFERENCE' AND next_reference_retry_at <= now() ORDER BY next_reference_retry_at LIMIT batchSize FOR UPDATE SKIP LOCKED`, implementado via QueryBuilder raw (`MikroOrmPendingReferenceWorkerRepository`).
- `PendingReferenceWorkerUnitOfWork` = `{ pendingReferenceWorker, wagerTransaction, wallet, outbox }`, com seu próprio `TransactionRunner` (`MikroOrmPendingReferenceWorkerTransactionRunner`), mesma disciplina de `em.fork()` por transação dos demais runners.
- `RetryPendingReferencesUseCase.execute()` — abre uma única transação, faz o claim, e para cada item do batch chama `processOne()`: se a referência agora existe, delega para `ResolveAndApplyWagerTransaction.execute()` (seção 22) com `persistenceMode: 'update'` — a mesma validação de compatibilidade, lock de wallet, ledger e outbox do fluxo normal, sem reimplementar nada; se não existe e ainda há tentativas, reagenda; se o limite estourou, rejeita. Claim, resolução/reagendamento/rejeição e outbox sempre na mesma transação — nunca dividido.

**Política de retry — `ReferenceRetryPolicy`, fonte única de verdade:** backoff exponencial com cap, `delay(attempt) = min(baseDelayMs * 2^(attempt-1), maxDelayMs)` (`nextReferenceRetryDelayMs`), `maxAttempts` como política de aplicação — **nunca** um `CHECK` no schema. A mesma instância de `ReferenceRetryPolicy` é injetada tanto em `ProcessWagerTransactionUseCase` (primeiro agendamento, `nextReferenceRetryDelayMs(policy, 1)`) quanto no worker (agendamentos seguintes, `attemptNumber` crescente) — não existe mais uma constante hardcoded separada para o primeiro agendamento (ver "bug real" abaixo).

**Semântica de `referenceRetryAttempts`:** número **total** de tentativas de resolução já realizadas, incluindo a tentativa inicial que levou a `PENDING_REFERENCE` (`markPendingReference` sempre incrementa, mesmo na primeira chamada). `maxAttempts` da política é comparado diretamente contra esse total — não é um contador de retries *adicionais* além da tentativa inicial.

**Saldo no veredito de rejeição por limite esgotado:** quando o limite de tentativas se esgota, o worker adquire o lock da wallet (`findByIdForUpdate`) **somente nesse branch** — nunca durante um simples reagendamento, para não pagar o custo do lock sem necessidade — e usa `wallet.balance` real como `resultBalance` em `transaction.reject('REFERENCE_NOT_FOUND', wallet.balance)`, nunca `transaction.money` (que é só o valor da própria operação, ex.: R$30 do REFUND, não o saldo da carteira). Testado com um cenário em que o valor do REFUND é deliberadamente diferente do saldo real da wallet, provando que `result_balance_amount` reflete o saldo observado, não o valor da transação.

**Concorrência multi-instância:** garantida inteiramente por `FOR UPDATE SKIP LOCKED` no claim — duas instâncias do worker nunca processam a mesma pendência simultaneamente. Sem lock global, sem estado em memória, sem lock compartilhado entre wallets. Testado com duas instâncias concorrentes reais (`Promise.all`) contra o mesmo item pendente: exatamente uma resolve.

### Bug real encontrado e corrigido nesta rodada 1: duas fontes de verdade para o delay do primeiro agendamento

`ProcessWagerTransactionUseCase` tinha `INITIAL_REFERENCE_RETRY_DELAY_MS = 30_000` hardcoded, independente da `ReferenceRetryPolicy` recém-formalizada para o worker. Com uma política de teste usando `baseDelayMs` diferente de 30s, o primeiro agendamento calculava um `next_reference_retry_at` incompatível com o clock do teste, e `claimBatch` (corretamente) nunca encontrava a linha — sintoma: `claimed: 0` em quase todos os testes do worker. Corrigido removendo a constante e injetando a mesma `ReferenceRetryPolicy` em `ProcessWagerTransactionUseCase`; o primeiro agendamento agora usa `nextReferenceRetryDelayMs(policy, 1)`, a mesma função que o worker usa para os agendamentos seguintes. Essa é a razão de a política ser injetada (não hardcoded) nos dois lugares — qualquer ajuste futuro de backoff só precisa mudar em um ponto.

### Bug real encontrado e corrigido nesta rodada 2: mapper de `WagerTransaction` não tratava `NULL` bruto de queries raw

`wagerTransactionRowToDomain` (usado por todo repositório que lê `wager_transaction`) guardava campos opcionais com `!== undefined`. Isso é correto para linhas hidratadas via `em.findOne`/`em.find` — o MikroORM coage coluna nullable ausente para `undefined` nesse caminho — mas `PendingReferenceWorkerRepository.claimBatch()` é o único lugar do projeto que lê `WagerTransactionRow` via `QueryBuilder.execute('all')` bruto, que devolve `NULL` do Postgres como `null` literal, não `undefined`. Resultado: `resultBalanceAmount: null` passava pelo guard, e `Money.from({ amount: null, ... })` explodia com `Invalid money amount: "null"` em toda linha reivindicada pelo worker. Corrigido com um helper `isAbsent(value)` (`value === null || value === undefined`) aplicado uniformemente aos seis campos opcionais do mapper — não é uma correção pontual só para o worker, fecha a lacuna para qualquer futuro caller que use queries raw contra essa tabela.

### Lição de harness de teste: `orm.em.fork()` sempre, nunca a instância raiz `orm.em`, entre `TransactionRunner`s distintos no mesmo teste

Ao compartilhar a instância global `orm.em` (não forkada) entre dois `TransactionRunner`s diferentes dentro do mesmo teste (`ProcessWagerTransactionUseCase` + `RetryPendingReferencesUseCase`), o Identity Map do MikroORM corrompia a segunda leitura — sintoma inicial idêntico ao bug do mapper acima (`Money.from()` recebendo `"null"`), o que exigiu isolar as duas causas por reprodução em scripts separados antes de confirmar que eram bugs distintos. O próprio MikroORM proíbe esse uso: acessar o identity map da instância global fora de um contexto específico lança `"Using global EntityManager instance methods for context specific actions is disallowed... use fork() instead"`. Lição aplicada em todos os testes de integração deste worker: cada `TransactionRunner` construído num teste usa seu próprio `orm.em.fork()`, mesmo quando dois runners convivem no mesmo `it()`.

## 24. `failureCode` distinto para saldo insuficiente vs. reversão que geraria saldo negativo (README seção 7 regra 9)

**Lacuna encontrada:** a regra 9 exige que uma `BET` sem saldo e um `ROLLBACK`/`REFUND` que produziria saldo negativo carreguem `failureCode`s diferentes — são situações operacionalmente distintas (a primeira é o provider tentando gastar mais do que a wallet tem; a segunda é uma reversão de crédito que não pode mais ser desfeita porque o saldo já foi consumido por outra operação). Ambas nascem, porém, do mesmo `InsufficientBalanceError` lançado por `Wallet.debit()` — `Wallet` não conhece `WagerTransactionKind` (nunca deve conhecer, é a fronteira de módulo já fechada nas seções 3/15) e portanto não pode distinguir os dois casos sozinha.

**Correção:** a tradução acontece em `ResolveAndApplyWagerTransaction`, no `catch` que já traduz `KNOWN_REJECTION_ERRORS` em `REJECTED` — o único ponto do fluxo que conhece simultaneamente o erro lançado por `Wallet` e o `transaction.kind` que o originou. `failureCodeFor(err, transaction)`: se `err instanceof InsufficientBalanceError` e `transaction.kind === Rollback`, o código vira `'ReversalWouldOverdrawError'`; em qualquer outro caso (incluindo `BET` sem saldo), mantém `err.name` (`'InsufficientBalanceError'`). Nenhuma mudança em `Wallet` ou em `wallet.errors.ts` — o erro lançado continua sendo um só, só a tradução para `failureCode` passa a depender do contexto de quem chamou.

**Por que só `Rollback` precisa da checagem, nunca `Refund`:** `REFUND` sempre credita (nunca pode gerar `InsufficientBalanceError`, que só vem de `debit()`). `ROLLBACK` inverte o efeito da transação referenciada (`balanceEffectFor`) — só vira um débito quando reverte um `WIN` ou `REFUND` (créditos anteriores); reverter uma `BET` sempre credita de volta, nunca debita. Logo todo `InsufficientBalanceError` observado com `kind === Rollback` é, por construção, uma reversão que esvaziaria a wallet além do que ela tem — nunca uma aposta nova sem saldo.

**Teste:** `process-wager-transaction.use-case.test.ts` — cenário `BET` (100→20) → `WIN` de 150 referenciando o `BET` (20→170) → nova `BET` de 165 que consome a maior parte do crédito do `WIN` (170→5) → `ROLLBACK` do `WIN` tenta debitar 150 de uma wallet com apenas 5, rejeitado com `failureCode: 'ReversalWouldOverdrawError'`, explicitamente diferente de `'InsufficientBalanceError'`. Suíte completa: 172 pass / 0 fail. `bun run build`: limpo.

## 25. Grupo E (HTTP API) — `POST /wallets` + `GET /wallets/:walletId`: composition root Nest, `class-validator`, e o primeiro bug real de produção do projeto

**Wiring de produção pela primeira vez.** Até este incremento, nenhum use case do projeto era instanciado fora de testes — nem o consumer SQS, nem o outbox publisher, nem o worker de `PENDING_REFERENCE` tinham uma composition root real. `SystemClock` (`shared/infrastructure/system-clock.ts`) e `UuidIdGenerator` (movido de `__test-support__` para `shared/infrastructure/`, já que sempre foi uma implementação de produção legítima, só não tinha onde ser usada) são as primeiras implementações de `Clock`/`IdGenerator` conectadas de verdade. `IdGenerator`/`Clock`/`WalletRepository`/`WalletQueryRepository` são interfaces puras de `application/ports` — o Nest não resolve DI por tipo estrutural, então cada uma ganhou um token (`Symbol`) em `shared/infrastructure/shared.tokens.ts`, nunca dentro do arquivo da porta em si (isso acoplaria `application/ports`, que deve continuar sem NestJS, ao framework).

**`class-validator`/`class-transformer` — validação estrutural apenas, nunca regra financeira.** DTOs (`CreateWalletDto`, `MoneyDto`) validam shape/tipo/formato superficial (é string? é UUID? bate uma regex simples?) só para não instanciar um use case com payload obviamente malformado. A validação real de valor monetário (2 casas decimais exatas, moeda válida) continua sendo responsabilidade exclusiva de `Money.from()` — o DTO nunca duplica essa regra, só evita chamadas óbvias com lixo. `ValidationPipe` global (`whitelist: true, transform: true, forbidNonWhitelisted: true`) registrado via `APP_PIPE` em `app.module.ts`.

**Bug real de produção: `EntityManager` global usado fora de transação → 500 em todo `GET`.** `WalletModule` originalmente registrava `WALLET_REPOSITORY` como uma `useFactory` injetando `EntityManager` (`Scope.DEFAULT`, resolvido uma única vez no boot) direto no construtor de `MikroOrmWalletRepository`. `POST /wallets` funcionava (a rota passa por `MikroOrmCreateWalletTransactionRunner.run()`, que chama `em.transactional()` — método que nunca acessa o contexto global diretamente, sempre gerencia seu próprio fork/transação por chamada), mas `GET /wallets/:walletId` (leitura simples, `em.findOne()` direto, sem transação) batia no guard do próprio MikroORM: `ValidationError: Using global EntityManager instance methods for context specific actions is disallowed... use fork() instead` — exatamente o mesmo erro já documentado na seção 23 para um teste, agora reproduzido em produção.

**Decisão descartada: `MikroOrmMiddleware`/`RequestContext`.** A correção óbvia — registrar `MikroOrmModule.forMiddleware()` (que chama `RequestContext.create(orm.em, next)` via `AsyncLocalStorage` em toda rota) — foi implementada, testada, e revertida. Motivo: todo repositório do projeto, desde a primeira integração (seção 18), foi desenhado para receber um `EntityManager` **explicitamente forkado pelo caller** — nunca para depender de contexto ambiente implícito. `RequestContext` só resolve o problema para provider `Scope.DEFAULT` porque métodos específicos do MikroORM (`getContext()`) checam o `AsyncLocalStorage` internamente — mas isso introduziria uma **segunda estratégia de isolamento** coexistindo com a primeira (fork explícito), quando as duas nunca precisam coexistir e misturar as duas é fonte de bugs sutis (qual delas está de fato ativa em cada chamada deixa de ser óbvio lendo o código). `AppModule` deliberadamente não importa `MikroOrmModule.forMiddleware()`.

**Correção final: `WalletQueryRepository` — uma porta nova, só para leitura HTTP, com fork explícito por operação.** `MikroOrmWalletRepository` (usado dentro dos `UnitOfWork` financeiros) permanece intocado — continua recebendo sempre o `EntityManager` já forkado pela transação corrente, nunca fazendo fork por conta própria. Para a leitura fora de qualquer transação de escrita, uma porta nova (`wallet/application/ports/wallet-query.repository.ts`) e sua implementação `MikroOrmWalletQueryRepository` recebem `MikroORM` (não um `EntityManager`) e chamam `orm.em.fork()` explicitamente a cada `findById()` — um fork novo, descartável, por chamada, nunca reusado entre requests. `GetWalletUseCase` (`wallet/application/get-wallet.use-case.ts`) é a peça de aplicação que o controller consome; o controller nunca importa `MikroORM`/`EntityManager` — só os dois use cases prontos (`CreateWalletUseCase`, `GetWalletUseCase`), resolvidos via `WalletModule`.

**Distinção de responsabilidade, registrada para os próximos endpoints de leitura (ledger, consultas de wager transaction):** todo *write path* (qualquer fluxo que abre uma transação real) usa um `TransactionRunner` + repositórios que recebem o `EntityManager` já forkado pela transação (padrão fechado desde a seção 18, nunca reaberto aqui). Todo *read path* fora de uma transação de escrita (GETs simples) usa um `*QueryRepository` dedicado, que recebe `MikroORM` e faz seu próprio `fork()` por operação. As duas famílias nunca se misturam — um repositório de escrita nunca faz fork por conta própria; um `QueryRepository` nunca participa de um `UnitOfWork`.

**Validação externa de dinheiro não-negativo, sem alterar `Money`.** `MoneyDto.amount` usa `@Matches(/^\d+\.\d{2}$/)` — sem o `-?` que a regex interna de `Money` (`money.ts`) aceita. `Money` continua aceitando valores negativos internamente (é um requisito de domínio real: `resultBalance` e outros cálculos internos podem precisar representar um valor negativo mesmo quando a constraint do banco proíbe persistir um saldo negativo) — a restrição de "nunca negativo" é uma regra do *adapter* HTTP (nenhum provider tem caso de uso legítimo para submeter um valor monetário negativo de fora), não do value object em si.

**Cobertura HTTP automatizada:** `wallet.controller.integration.test.ts` sobe a `AppModule` real (mesma composition root de produção, incluindo `ValidationPipe`/`DomainErrorFilter` globais registrados via `APP_PIPE`/`APP_FILTER`) via `@nestjs/testing` + `supertest`, contra o mesmo Postgres real do docker-compose usado por todo outro teste de integração — nunca abre uma porta TCP real, nunca mocka a camada HTTP. Deliberadamente sem `app.useGlobalPipes()`/`useGlobalFilters()` manuais no setup do teste: se `app.module.ts` um dia parar de registrar o pipe ou o filter, o teste precisa falhar, não mascarar a regressão reconfigurando os dois por conta própria. 9 casos: `POST` válido → `201` com shape exato; `GET` existente → `200`; `GET` inexistente → `404`; `GET` com id malformado → `400`; duplicata `playerId`+`currency` → `409`; `amount` negativo → `400`; campo extra não declarado → `400` (`forbidNonWhitelisted`); 30 `GET`s concorrentes intercalados entre 3 wallets diferentes sem nenhuma resposta trazer dado de outra wallet — a prova principal de isolamento, junto com `AppModule` nunca importar `MikroOrmModule.forMiddleware()` e o `GET` simples funcionar; e uma asserção estrutural adicional (não a prova principal) — `RequestContext.currentRequestContext()` permanece `undefined` antes, durante e depois da sequência `POST`+`GET`, reforçando a ausência de contexto ambiente. Alvo desta suíte: o caminho `contrato HTTP → ValidationPipe → controller → DI/composition root → use case → query repository → Postgres` — nunca duplica a cobertura de regra de domínio já existente em `wallet.test.ts`/`create-wallet.*`.

Suíte completa: 181 pass / 0 fail (172 + 9 novos). `bun run build`: limpo.

## 26. `POST /wagering/transactions` — reusa `ProcessWagerTransactionUseCase` com `origin: 'http'`, sem duplicar Money/referência/saldo/idempotência/reversão

**Reuso total do use case existente.** `WagerTransactionController` não implementa nenhuma regra financeira — monta um `ProcessWagerTransactionCommand` com `origin: 'http'` (o mesmo campo que já existia desde a primeira versão do command, nunca usado até este incremento) e delega inteiramente a `ProcessWagerTransactionUseCase.execute()`, exatamente como o consumer SQS já fazia (seção 21). `payloadHash` usa a mesma `canonicalPayloadHash()` já existente — nenhuma segunda implementação. `correlationId: idempotencyKey` segue o mesmo precedente do consumer SQS (`correlationId: message.messageId` em `wager-transaction-message.mapper.ts`): o identificador único da submissão de entrada, para correlacionar todos os eventos de saída gerados por ela.

**Lacunas pré-existentes fechadas na borda HTTP, não no use case/domínio.** Duas lacunas já existiam antes deste incremento e afetariam qualquer payload malformado deste tipo: `MissingReferenceError`/`UnexpectedReferenceError` (kind × exigência de referência) e `NonPositiveAmountError` (valor zero) nunca estiveram em `KNOWN_REJECTION_ERRORS` de `ResolveAndApplyWagerTransaction` — se alcançassem o use case, propagariam como erro inesperado (`500`), não `REJECTED`. Decisão: **não tocar em `ResolveAndApplyWagerTransaction`/`WagerTransaction` para isso** (autoridade de negócio já fechada, seção 22) — barrar o payload estruturalmente incompatível em `400`, antes do use case, via validação de borda:

- `SubmitWagerTransactionDto.kind` é `@IsIn(['BET','WIN','LOSS','REFUND','ROLLBACK'])` — **`OPENING` deliberadamente ausente da lista**: é interna, "não pode ser submetida pela API nem pela fila" (README seção 6.3).
- `PositiveMoneyDto` (`shared/infrastructure/http/positive-money.dto.ts`), especialização de `MoneyDto` que troca a regex de `amount` para excluir `"0.00"` (`/^(?!0\.00$)\d+\.\d{2}$/`) — **sem alterar `MoneyDto`**, que `initialBalance` de `POST /wallets` ainda precisa aceitar `"0.00"` normalmente. A propriedade `amount` é redeclarada com `declare` (não `override` — as duas palavras-chave são incompatíveis sob `noImplicitOverride`/campo `declare`, que não gera inicializador de instância); verificado em runtime com `plainToInstance`/`validate()` isolados que os decorators de `class-validator` continuam funcionando corretamente sobre uma propriedade `declare`d antes de confiar nisso na suíte completa.
- `ReferenceRequirementMatchesKindConstraint` (`wagering/infrastructure/http/reference-requirement.validator.ts`) — um único `@Validate()` de classe na propriedade `referenceExternalTransactionId`, em vez de múltiplos `@ValidateIf()`. Motivo: `@IsOptional()` faz o `class-validator` pular **todos** os demais decorators da mesma propriedade quando o valor está ausente — exatamente o caso que REFUND/ROLLBACK sem referência precisa capturar como inválido. Um único validador cobre as três categorias (exige/proíbe/permite opcionalmente) sem essa armadilha, e torna impossível a exigência de referência cair fora delas por omissão.
- Toda essa validação é **estrutural (shape do payload por kind), nunca a autoridade de negócio**: `WagerTransaction.assertReferenceRequirement()`/`assertCompatibleReference()` continuam sendo a única fonte de verdade real (identidade provider/player/wallet/moeda/round, status `PROCESSED`, valor exato) — o DTO só barra o caso óbvio antes de gastar uma transação SQL com ele.

**Pendência registrada, não fechada: o consumer SQS tem as mesmas três lacunas.** `OPENING` submetido via fila, uma referência estruturalmente incompatível com o kind, ou um valor zero — nenhum desses é bloqueado hoje em `wager-transaction-message.mapper.ts`/`WagerTransactionConsumer`, e resultariam no mesmo comportamento problemático (erro inesperado, não classificado como payload permanente/malformado) que motivou fechar isso agora do lado HTTP. Fechar o DTO HTTP não resolve isso globalmente — quando o consumer for revisitado, ele precisa da mesma classificação (payload permanentemente malformado → não-ACK e DLQ direto, nunca redelivery indefinido tratando como erro transitório). Não reaberto neste incremento.

**Mapper/presenter central do resultado HTTP — nenhuma condicional de status espalhada no controller.** `toSubmitWagerTransactionHttpResult()` (`submit-wager-transaction.presenter.ts`) é o único lugar que traduz `ProcessWagerTransactionResult` para `{ httpStatus, body }`:

| `result.kind` | HTTP status | Base do status |
|---|---|---|
| `idempotency-conflict` | `409` | fixo |
| `processed` / `rejected` / `pending-reference` / `replay` | `200` ou `202` | **`transaction.status` real**, nunca `result.kind` |
| `already-acked` / `permanent-error` | — | `throw` — inalcançável via HTTP (só nascem do branch Inbox, `origin === 'queue'`); um `default` exaustivo garante que, se um dia isso mudasse, o erro apareceria alto como bug de wiring, nunca silenciosamente virasse um status HTTP qualquer |

**`replay` espelha o status real da transação, nunca um `200` fixo.** `PROCESSED`/`REJECTED` → `200`; `PENDING_REFERENCE` → `202` — inclusive em replay: idempotência responde "essa submissão já foi recebida?" (`idempotentReplay: true` no corpo), enquanto o status HTTP continua respondendo "qual é o estado atual do processamento?" — as duas perguntas são independentes, e a primeira nunca deve esconder a segunda. Consequência direta: uma `PENDING_REFERENCE` retorna `202` tanto na primeira submissão quanto em todo replay enquanto permanecer pendente; se o worker resolvê-la depois (seção 23) e um novo replay encontrar `PROCESSED`/`REJECTED`, o status vira `200` naquele momento — nunca um `202` congelado como metadado histórico da primeira resposta. `resultBalance`/`failureCode` só aparecem no corpo quando presentes na transação (`PENDING_REFERENCE` nunca tem `balance`, por exemplo — nada foi aplicado ainda).

**Status HTTP dinâmico via `@Res({ passthrough: true })`.** `@HttpCode()` do Nest é estático (fixo em tempo de decoração); como este endpoint precisa de `200`/`202`/`409` conforme o resultado, o controller recebe o `Response` do Express com `passthrough: true` (mantém o pipeline normal do Nest para serialização do corpo) e chama `res.status(httpStatus)` explicitamente com o valor calculado pelo presenter.

**Testes:** validação runtime isolada de `PositiveMoneyDto` (zero/negativo/válido/tipo-errado) e de `ReferenceRequirementMatchesKindConstraint` (as 5 combinações kind × presença de referência, incluindo `OPENING` rejeitado) antes de montar a suíte completa. `wager-transaction.controller.integration.test.ts` — mesmo padrão de `wallet.controller.integration.test.ts` (`AppModule` real, sem `useGlobalPipes`/`useGlobalFilters` manuais, Postgres real), 13 casos: `BET` válido → `200` `PROCESSED`; `BET` sem saldo → `200` `REJECTED` com `failureCode`; `REFUND` referenciando algo inexistente → `202` `PENDING_REFERENCE` sem `balance` no corpo; replay de `PENDING_REFERENCE` preserva `202`; replay de `PROCESSED` retorna `200` com o resultado original + `idempotentReplay: true`; mesma key com payload diferente → `409`; `kind: OPENING` → `400`; `amount` zero → `400`; `amount` negativo → `400`; `BET` com referência indevida → `400`; `REFUND` sem referência → `400`; header ausente → `400`; campo extra não declarado → `400`.

Suíte completa: 194 pass / 0 fail (181 + 13 novos). `bun run build`: limpo.

## 27. Consultas de `WagerTransaction` — `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

**README não define o shape de resposta destas duas rotas** (seção 9, "Consultas" — só lista os paths, sem exemplo de JSON, diferente de `POST /wallets`/`POST /wagering/transactions`, que têm ambos request e response documentados). O shape abaixo é uma decisão deste incremento, ancorada no shape de `WagerTransaction` (seção 6.3) e na mesma filosofia de campos já usada na resposta do `POST` (seção 26).

**Mesmo padrão write-path/read-path de `GET /wallets/:walletId` (seção 25), replicado sem exceção:**
- `WagerTransactionQueryRepository` (porta nova, `wagering/application/ports/`) — `findById`/`findByProviderAndExternalId` numa única porta (as duas rotas leem o mesmo agregado por chaves diferentes, não dois propósitos distintos de leitura).
- `MikroOrmWagerTransactionQueryRepository` recebe `MikroORM` (não `EntityManager`) e faz `orm.em.fork()` por operação — **nunca reaproveita `MikroOrmWagerTransactionRepository`** (o repositório de escrita, usado só dentro de `WageringUnitOfWork`/`MikroOrmTransactionRunner`). As ~4 linhas de `findOne()` são deliberadamente duplicadas em vez de forçar o repositório transacional a servir de query adapter fora de uma transação — a mesma separação já fechada na seção 25, sem exceção para este endpoint.
- `GetWagerTransactionByIdUseCase`/`GetWagerTransactionByProviderAndExternalIdUseCase` — dois use cases pequenos e específicos (não um único "genérico" parametrizado por modo de busca), mesma filosofia de `GetWalletUseCase`.
- `toWagerTransactionResponse()` (`wager-transaction.presenter.ts`) — serialização explícita a partir do domínio. Campos deliberadamente **excluídos** da resposta: `idempotencyKey`/`payloadHash` (redundantes — o provider é quem os enviou) e `referenceRetryAttempts`/`nextReferenceRetryAt` (detalhes internos do worker de recovery, seção 23 — não é informação que a API pública deveria vazar).

**Controller novo e dedicado, separado de `WagerTransactionController` (o `POST`).** As duas rotas de consulta têm prefixos de path completamente diferentes (`/wagering/transactions/...` vs `/providers/...`) — `WagerTransactionQueryController` usa `@Controller()` sem prefixo de classe, com o path completo declarado em cada `@Get()`, em vez de um override de path difícil de ler dentro de um controller cujo prefixo só bate com uma das duas rotas. `WagerTransactionController` permanece focado exclusivamente em submissão.

**`ParseUUIDPipe` só em `transactionId`.** `providerId`/`externalTransactionId` são identificadores externos livres, definidos pelo provider — nenhuma validação de formato que o README não exige; um valor sem correspondência vira `404`, nunca `400` (diferente de `transactionId`, que é sempre um UUID gerado internamente, então um valor mal formado é sempre `400`, nunca poderia ter uma correspondência mesmo se existisse).

**`kind: 'OPENING'` é visível na consulta, mesmo bloqueado na submissão.** A restrição do README (seção 6.3, "não pode ser submetida pela API nem pela fila") é sobre **entrada**: o que pode ser *criado* externamente via `POST /wagering/transactions`. Uma wallet criada com saldo inicial > 0 gera uma `WagerTransaction` `OPENING` real, persistida e auditável (`CreateWalletUseCase`, seção 19) — a consulta reflete fielmente o que existe no banco, sem filtro escondendo `OPENING` no query repository/use case. Transformar `OPENING` numa entidade "invisível" apesar de participar do histórico financeiro seria inconsistente com a própria natureza de auditoria do ledger.

**Testes:** `wager-transaction-query.controller.integration.test.ts` — mesmo padrão dos demais testes HTTP (`AppModule` real, sem `useGlobalPipes`/`useGlobalFilters` manuais, Postgres real), 8 casos: `GET` por `transactionId` de uma `PROCESSED` → `200` com shape completo; `transactionId` bem formado mas inexistente → `404`; `transactionId` malformado → `400`; `GET` por `(providerId, externalTransactionId)` existente → `200`; inexistente → `404` (nunca `400` — confirma a decisão acima); `PENDING_REFERENCE` consultada → `200` com `balance`/`processedAt`/`failureCode` ausentes do corpo (não `null`); `REJECTED` consultada → `200` com `failureCode` presente; a `OPENING` de uma wallet com saldo inicial → `200` com `kind: 'OPENING'` em **ambas** as rotas de consulta (por `providerId`/`externalTransactionId` determinísticos — `internal`/`opening:${walletId}` — e por `transactionId`).

Suíte completa: 202 pass / 0 fail (194 + 8 novos). `bun run build`: limpo.

## 28. `GET /wallets/:walletId/ledger` — paginação por cursor keyset, `(created_at, id)`

**README não especifica o shape de resposta nem o formato do cursor** (seção 9 — só `GET /wallets/:walletId/ledger?cursor=...&limit=50 # cursor estável e opaco`). Todos os detalhes técnicos abaixo (encoding, ordenação exata, limites, comportamento de borda) são decisões deste incremento.

### Bug real encontrado e corrigido ANTES da implementação — off-by-one na montagem de `nextCursor`

A primeira proposta calculava `nextCursor` a partir da **linha `limit+1`** buscada só para detectar se havia próxima página (`rows[limit]`, a linha extra, nunca entregue ao cliente). Isso é um bug real de paginação: como a query seguinte usa `(created_at, id) > cursor`, um cursor derivado da linha `limit+1` faria a próxima página pular exatamente essa linha — ela nunca apareceria em nenhuma resposta, violando a garantia obrigatória "nenhum item pulado". Corrigido antes de qualquer código ser escrito: `hasNextPage = rows.length > limit`; `entries = rows.slice(0, limit)`; `nextCursor` é derivado do **último item de `entries`** (`entries[entries.length - 1]`), nunca da linha extra descartada. Reproduzido e confirmado manualmente via HTTP real (5 lançamentos, `limit=2`, 3 páginas) antes de escrever a suíte automatizada, e coberto por um teste de regressão dedicado (`wallet-ledger.controller.integration.test.ts`, "off-by-one regression").

### Peças, mesmo padrão write-path/read-path das seções 25/27, sem exceção

- `WalletLedgerQueryRepository` (porta) — `fetchPage(walletId, cursor, limit)`, sempre busca `limit+1` internamente; a decisão de cortar a linha extra e montar `nextCursor` é do use case, nunca do repository.
- `MikroOrmWalletLedgerQueryRepository` recebe `MikroORM` (não `EntityManager`), `orm.em.fork()` por operação — nunca reaproveita nenhum repositório de escrita. A comparação de tupla `(created_at, id) > (cursor.createdAt, cursor.id)` é expressa via `QueryBuilder` com `$or: [{createdAt: {$gt}}, {createdAt: {$eq}, id: {$gt}}]` — logicamente equivalente à comparação de tupla, plana sobre o índice composto já existente `ledger_wallet_id_created_at_id_idx (wallet_id, created_at, id)` — **nenhuma migration nova**. `ORDER BY created_at ASC, id ASC`: mais antigo primeiro (histórico financeiro cronológico); `id` é só desempate determinístico (os IDs são UUID v4 aleatórios — `randomUUID()`, sem significado temporal), nunca a chave primária de ordenação.
- `GetWalletLedgerUseCase` — só sabe paginar um `walletId` que o caller já confirmou existir; nunca decide sobre a existência da wallet (isso é do controller, ver abaixo). `DEFAULT_LEDGER_LIMIT = 50`/`MAX_LEDGER_LIMIT = 200` centralizados aqui, únicos, reusados por `parseLedgerLimit` e pelos testes — nenhum número mágico duplicado.
- `wallet-ledger-cursor.ts` — `encodeLedgerCursor`/`decodeLedgerCursor`, puros, sem framework, testados isoladamente (`wallet-ledger-cursor.test.ts`, 9 casos). Encoding: `base64url(JSON.stringify({createdAt: ISO, id}))` — `base64url`, não `base64` padrão, porque o cursor viaja como valor de query string (`base64` pode conter `+`/`/`, que exigiriam URL-encoding extra; `base64url` é seguro sem escaping). Sem assinatura/HMAC — opaco mas não precisa ser à prova de adulteração deliberada: a query sempre filtra por `walletId` do path param (nunca confia em nada do cursor para escopo de wallet), e é leitura pura — um cursor adulterado no máximo produz uma página estranha/vazia para aquele `walletId`, nunca vaza outra wallet nem quebra invariante financeira.
- `wallet-ledger-limit.ts` — `parseLedgerLimit`, contrato determinístico e rígido, sem clamp silencioso: ausente → `DEFAULT_LEDGER_LIMIT`; inteiro `1..MAX_LEDGER_LIMIT` → válido; qualquer outro valor (zero, negativo, não inteiro, não numérico, acima do máximo) → `InvalidLedgerLimitError`. Um cliente pedindo uma quantidade fora do intervalo descobre imediatamente, em vez de receber silenciosamente uma resposta diferente da solicitada.
- `WalletController.getLedger()` — reaproveita `GetWalletUseCase` (a **mesma** consulta de `GET /wallets/:walletId`, nunca duplicada) para checar a existência da wallet antes de paginar o ledger: `404` explícito distingue "wallet não existe" de "wallet existe, ledger vazio" (`200`, `entries: []`). `GetWalletLedgerUseCase` nunca decide isso — mantém a regra de ledger isolada da checagem de existência.
- `DomainErrorFilter` generalizado para múltiplos tipos: `InvalidLedgerCursorError`/`InvalidLedgerLimitError` → `400`, ao lado de `WalletAlreadyExistsError` → `409` já existente — mesma disciplina de captura explícita por tipo (`@Catch(TypoA, TypoB, TypoC)`), nunca "qualquer erro vira 4xx".

**Testes:** `wallet-ledger-cursor.test.ts` (9 casos: round-trip, formato base64url sem `+`/`/`/`=`, e cada forma de cursor malformado) + `wallet-ledger-limit.test.ts` (8 casos: default, válido nos limites, e cada forma de valor inválido) + `wallet-ledger.controller.integration.test.ts` (11 casos: primeira página em ordem cronológica com `nextCursor`; seguir o cursor continua sem gap/repetição; página final com `nextCursor: null`; ledger vazio; wallet inexistente `404`; `walletId` malformado `400`; cursor malformado `400`; os 5 valores inválidos de `limit` `400`; `limit=200` aceito; defaults sem `cursor`/`limit`; e o teste de regressão dedicado do off-by-one — 5 entradas, `limit=2`, 3 páginas, concatenação idêntica a uma leitura única não paginada).

Suíte completa: 230 pass / 0 fail (202 + 11 integração + 17 unitários). `bun run build`: limpo.

## 29. `POST /wallets/:walletId/reconciliation` — reconstrução do ledger, e a fundação de observabilidade (Prometheus/Loki/Grafana/Alloy)

**README não especifica o algoritmo de reconstrução** (seção 9, "Reconciliação" — só o shape de resposta e "divergências não são corrigidas silenciosamente: devem ser logadas, contabilizadas em métrica e sinalizadas na resposta"). O algoritmo abaixo foi avaliado explicitamente entre duas alternativas antes de qualquer código ser escrito, e recebeu uma quarta checagem num hardening posterior (ver "Hardening pós-revisão" ao final desta seção).

### O caso de uso — completo, não depende de `GetWalletUseCase`

`ReconcileWalletUseCase.execute(walletId: string)` recebe o `walletId`, busca a própria wallet via `WalletQueryRepository` (a **mesma** porta que `GetWalletUseCase` usa — os dois são consumidores independentes dela, nenhum depende do outro), e devolve um resultado discriminado: `{ kind: 'wallet-not-found' } | { kind: 'reconciled'; reconciliation: ReconciledWallet }`. O controller só converte `wallet-not-found` em `404` — toda a decisão de "a wallet existe?" mora no use case, não espalhada entre controller e use case. Isso substitui um desenho anterior onde o controller lia a wallet via `GetWalletUseCase` e passava o objeto `Wallet` já carregado para `ReconcileWalletUseCase.execute(wallet)` — corrigido porque um "caso de uso" que recebe a entidade já resolvida por outro caller não é completo por si só (não pode ser chamado, por exemplo, por um job agendado futuro sem esse job replicar a lógica de resolução de wallet).

### O algoritmo — por que nem "somar desde zero" nem "só validar a cadeia" sozinhos bastam

**Alternativa A (rejeitada): somar `CREDIT`/`DEBIT` desde um zero assumido.** `calculatedBalance = Σ CREDIT - Σ DEBIT`, nunca lê `balanceBefore`/`balanceAfter` de nenhum lançamento. Cega a dois tipos de corrupção: (1) se o **próprio primeiro lançamento** já nasceu com `balanceBefore` corrompido (não-zero), a soma "desde zero" não reflete o histórico real; (2) é **insensível à ordem/continuidade da cadeia** — um lançamento fora de posição ou um gap no meio ainda contribui corretamente para o total, então nunca seria detectado, apesar de ser uma corrupção real.

**Alternativa B ingênua (rejeitada sozinha): ancorar em `entries[0].balanceBefore`, sem validar esse próprio valor.** Resolve o problema de continuidade (`entries[i].balanceAfter === entries[i+1].balanceBefore`), mas se o próprio ponto de ancoragem estiver corrompido, a fórmula reconciliaria "corretamente" contra um valor de partida já errado, sem nunca reportar isso.

**Adotado: as duas combinadas, mais a validação do próprio ponto de ancoragem e da aritmética interna de cada lançamento — quatro checagens independentes, `consistent` só é `true` se as quatro se sustentarem:**

1. **Ponto de ancoragem — validado, nunca assumido.** Se há algum lançamento, `entries[0].balanceBefore` DEVE ser `Money.zero(currency)` — não por suposição arbitrária da reconciliação, mas porque `Wallet.open()` é a **única** factory de criação de `Wallet` em todo o código de produção (confirmado por varredura: nenhum outro caminho cria uma wallet com saldo não-zero sem passar por `applyMovement()`, que sempre gera um lançamento), e sempre nasce com saldo zero. Se `entries[0].balanceBefore !== 0.00`, isso é reportado como `reason: 'invalid_anchor'` — e o **valor real persistido é usado no cálculo mesmo assim**, nunca substituído por zero à força (isso seria "corrigir silenciosamente", proibido pelo README).
2. **Aritmética interna de cada lançamento.** `entry.isBalanced()` (`balanceBefore ± amount === balanceAfter`, já existente em `WalletLedgerEntry`) para **todo** lançamento — detecta um lançamento cuja própria aritmética está corrompida, mesmo que a continuidade com o vizinho e o saldo final "por acaso" batam (a soma independente do item 4 nunca copia `balanceAfter`, então um `balanceAfter` corrompido isolado não vaza para o saldo final calculado — só a checagem explícita de `isBalanced()` pega esse caso). Reportado como `reason: 'invalid_entry'`.
3. **Continuidade da cadeia.** Para cada par consecutivo, `entries[i].balanceAfter === entries[i+1].balanceBefore` — detecta um lançamento fora de posição ou um gap, algo que a Alternativa A nunca detectaria. Reportado como `reason: 'broken_chain'`.
4. **Soma final.** `calculatedBalance` (derivado de `entries[0].balanceBefore + Σ CREDIT - Σ DEBIT`, calculado por soma independente — nunca copiando `balanceAfter` do último lançamento) precisa bater com `storedBalance` (`wallet.balance`). Reportado como `reason: 'balance_mismatch'`.
5. **Ledger vazio:** `calculatedBalance = Money.zero(wallet.currency)` — não por suposição, mas pela mesma razão do item 1 (só `Wallet.open()` cria uma wallet, e ela nasce em zero; uma wallet sem nenhum lançamento só pode ser logicamente consistente com saldo zero).

**Semântica do incremento da métrica: um por execução inconsistente, nunca um por tipo de inconsistência detectado.** Se múltiplos problemas independentes existirem na mesma execução, `reason` reflete a **primeira** checagem que falhou, numa ordem de prioridade **fixa** — `invalid_anchor → invalid_entry → broken_chain → balance_mismatch` — nunca a ordem em que os lançamentos foram varridos durante o loop de reconstrução. O `reason` é decidido só ao final, comparando as quatro condições já computadas por completo, não durante a iteração (evita que um `broken_chain` "descoberto primeiro" no lançamento 1 vença um `invalid_entry` mais grave descoberto no lançamento 3). Testado explicitamente com dois cenários de conflito de prioridade (`invalid_anchor` vs. `balance_mismatch`; `invalid_entry` vs. `broken_chain`) — em ambos, exatamente um incremento, com o `reason` de maior prioridade.

**`difference` preserva o sinal — `storedBalance.subtract(calculatedBalance)`, nunca valor absoluto.** Positivo: saldo armazenado acima do reconstruído. Negativo: abaixo. Zero: consistente. `Money.subtract()` já suporta negativo nativamente (só `Wallet.debit()`/`credit()` validam positividade — `Money` em si não), então nenhuma lógica extra foi necessária.

**Estritamente leitura — nenhum `TransactionRunner`/`em.flush()` em nenhum ponto.** Provado por teste de integração dedicado: `wallet.version`/`balance`/contagem de linhas do ledger idênticos antes e depois de duas chamadas consecutivas ao endpoint.

### Fundação de observabilidade — Prometheus (métricas) + Loki (logs) + Grafana (visualização) + Grafana Alloy (coletor)

Decisão de stack para o projeto, registrada aqui e a ser completada no Grupo H — **este incremento implementa só a fundação necessária para a métrica de reconciliação funcionar de verdade, não o Grupo H inteiro** (sem dashboards Grafana, sem configuração final de Loki/Alloy, sem as demais métricas obrigatórias da seção 12 do README).

- **`MetricsPort`/`Logger`** (`shared/application/`) — portas puras, application nunca importa `prom-client`/conhece Prometheus, Loki ou qualquer SDK de observabilidade diretamente. Mesma disciplina de toda porta já fechada no projeto (Money/Wallet/UnitOfWork, seção 3).
- **`PrometheusMetrics`** (`shared/infrastructure/`) — única classe do projeto que importa `prom-client`. Um `Counter` por `name`, criado sob demanda e cacheado num `Map` (prom-client lança se dois `Counter`s forem registrados com o mesmo nome no mesmo `Registry` — o cache é necessário, não só otimização). Registrado como singleton único (`Scope.DEFAULT` padrão do Nest, sem factory) em `SharedModule` — um único `Registry` compartilhado por toda a aplicação, para que um futuro endpoint `/metrics` (Grupo H) consiga expor todos os contadores de qualquer feature module juntos.
- **`ConsoleLogger`** (`shared/infrastructure/`) — extraído do padrão já usado por `WagerTransactionConsumerLogger` (JSON estruturado via `console.log`/`warn`/`error`) para uma implementação compartilhada e reusável. **`WagerTransactionConsumerLogger` não foi migrado para esta interface neste incremento** — é um arquivo já fechado (seção 21); migrá-lo é uma decisão separada, a propor e aprovar isoladamente depois, não decidida silenciosamente aqui.
- **Sem labels de alta cardinalidade.** `wallet_reconciliation_divergences_total` tem só `reason` (`invalid_anchor` | `invalid_entry` | `broken_chain` | `balance_mismatch`) como label — nunca `walletId`/`transactionId`/`playerId` (README seção 12: "sem dados sensíveis ou payloads financeiros completos nos logs" — o princípio de baixa cardinalidade em métricas é a mesma disciplina aplicada ao lado Prometheus). Esses identificadores aparecem **só** no log estruturado (`walletId`, `storedBalance`, `calculatedBalance`, `difference`, `checkedEntries`, `reason` — nunca payload financeiro completo, só os valores agregados já expostos na própria resposta HTTP).
- **Loki/Grafana/Grafana Alloy**: nenhuma integração de código neste incremento — a fundação aqui é só emitir JSON estruturado em stdout/stderr (`ConsoleLogger`) e expor contadores num `Registry` Prometheus (`PrometheusMetrics`); a coleta/encaminhamento real (Alloy → Loki para logs, Alloy/scrape → Prometheus para métricas) e os dashboards (Grafana) ficam para o Grupo H.

**Testes:** `reconcile-wallet.use-case.test.ts` (12 casos, com fakes — `FakeWalletQueryRepository`/`FakeWalletLedgerQueryRepository`/`FakeMetrics`/`FakeLogger`, todos novos em `wallet/application/__fakes__/`, primeiro conjunto de fakes do módulo wallet): `wallet-not-found` sem tocar ledger/métrica/log; ledger vazio consistente; ledger vazio com `storedBalance` não-zero (inconsistente, nunca mascarado); cadeia bem formada consistente (single e multi-entry); `balance_mismatch` com `difference` positivo e negativo; `invalid_anchor` (valor real persistido usado no cálculo, nunca substituído por zero); **`invalid_entry`** — um único lançamento com `balanceBefore: 0.00` (âncora válida) mas `balanceAfter` corrompido, desenhado deliberadamente para não disparar `invalid_anchor` (âncora é zero), `broken_chain` (lançamento único, sem par seguinte para comparar) nem `balance_mismatch` (a soma independente por `direction`/`amount` nunca copia o `balanceAfter` corrompido, então bate com `storedBalance` mesmo assim) — só `entry.isBalanced()` pega esse caso; `broken_chain`; e dois testes de prioridade determinística — `invalid_anchor` vencendo `balance_mismatch`, e `invalid_entry` vencendo `broken_chain` — provando que a ordem fixa é respeitada independentemente da ordem de varredura. Cada teste prova, pela ausência de qualquer import de `prom-client`/Prometheus no arquivo, que o use case depende só de `MetricsPort` — nunca da implementação concreta. `prometheus-metrics.test.ts` (3 casos: incremento, contadores separados por label, reuso do mesmo `Counter` sem re-registro). `wallet-reconciliation.controller.integration.test.ts` (5 casos, Postgres real: histórico real consistente com o shape exato do README; ledger vazio; wallet inexistente `404`; `walletId` malformado `400`; e a prova de "nunca escreve nada" chamando o endpoint duas vezes e comparando `wallet`/ledger antes e depois). Cenários de corrupção deliberada não duplicados via HTTP/SQL bruto — já cobertos de forma direta e determinística nos testes unitários com fakes.

Validado manualmente via HTTP real antes e depois do hardening, incluindo corrupção real via SQL direto (`UPDATE wallet SET balance_amount = '999.00'`) confirmando `consistent: false`, `difference` com sinal correto, log estruturado emitido no formato esperado, e o novo fluxo `execute(walletId)` com `404` para wallet inexistente funcionando corretamente em produção.

### Hardening pós-revisão (dois itens, sem reabrir a estratégia de observabilidade)

1. **`ReconcileWalletUseCase` tornado um caso de uso completo** — recebia `Wallet` já resolvido pelo controller (via `GetWalletUseCase`); passou a receber `walletId` e resolver a própria wallet via `WalletQueryRepository` injetada diretamente (a mesma porta de `GetWalletUseCase`, nunca uma dependência de um use case sobre o outro), devolvendo um resultado discriminado `wallet-not-found | reconciled`. O controller ficou mais fino ainda: só converte `wallet-not-found` em `404`.
2. **Quarta checagem, `invalid_entry`** — `entry.isBalanced()` validado para todo lançamento, fechando a lacuna de um lançamento individual com aritmética interna corrompida que nem a ancoragem, nem a continuidade, nem a soma (por si só) garantiam detectar. Ordem de prioridade da métrica estendida para `invalid_anchor → invalid_entry → broken_chain → balance_mismatch`, decidida ao final da reconstrução (nunca durante a iteração), com testes de conflito de prioridade dedicados.

Nenhuma mudança na estratégia Prometheus/Loki/Grafana/Alloy nem migração do consumer para o `Logger` compartilhado neste hardening.

Suíte completa: 250 pass / 0 fail (247 + 3 novos: `invalid_entry` e o teste extra de prioridade `invalid_entry` vs. `broken_chain`). `bun run build`: limpo.