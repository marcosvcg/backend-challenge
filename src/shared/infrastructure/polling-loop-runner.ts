/** Infraestrutura de lifecycle, não domínio/application — envolve um único
 *  passo single-shot (ex.: PublishPendingOutboxMessagesUseCase.execute(),
 *  RetryPendingReferencesUseCase.execute()) num loop com intervalo fixo entre
 *  execuções.
 *
 *  Mesma disciplina de stopping flag + pollLoop: Promise<void> já usada por
 *  WagerTransactionConsumer (ARCHITECTURE.md seção 21) — stop() é idempotente
 *  e só retorna depois que a iteração em andamento termina; nenhum novo poll
 *  começa depois que stopping vira true.
 *
 *  Deliberadamente `while (!stopping) { await step(); await sleep(...) }`,
 *  NUNCA setInterval: setInterval dispara na cadência do timer
 *  independentemente de quanto tempo a execução anterior levou — se `step()`
 *  demorar mais que intervalMs, execuções concorrentes se sobrepõem. O loop
 *  explícito garante que o intervalo só começa a contar DEPOIS que a
 *  execução anterior termina — nunca duas iterações em voo ao mesmo tempo.
 *
 *  O sleep entre iterações é INTERROMPÍVEL por stop(): sem isso, chamar
 *  stop() enquanto o loop está dormindo (o caso comum — a maior parte do
 *  tempo de vida do loop é passada dormindo, não executando step()) faria
 *  stop() bloquear até o intervalMs inteiro decorrer, mesmo com a flag já
 *  marcada — inaceitável para um intervalMs de produção (segundos), onde
 *  isso violaria o requisito de shutdown gracioso rápido. */
export class PollingLoopRunner {
  private stopping = false;
  private pollLoop?: Promise<void>;
  private wakeStop?: () => void;

  constructor(
    private readonly step: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  start(): void {
    this.stopping = false;
    this.pollLoop = this.runLoop();
  }

  /** Idempotente: chamar stop() sem um start() anterior, ou chamar duas
   *  vezes seguidas, nunca lança — pollLoop é undefined ou já resolvido, e
   *  await sobre isso simplesmente retorna. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeStop?.(); // interrompe um sleep() em andamento, se houver
    await this.pollLoop;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.step();
      } catch (err) {
        // Um erro inesperado numa iteração nunca derruba o loop nem cria
        // execuções concorrentes — é reportado (onError) e o loop segue para
        // o próximo sleep/iteração normalmente, exatamente como se a
        // iteração tivesse simplesmente não encontrado nada para fazer.
        this.onError(err);
      }
      if (this.stopping) break; // não dorme desnecessariamente se stop() já foi chamado durante step()
      await this.sleep(this.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeStop = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
