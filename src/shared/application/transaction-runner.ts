/** Genérico sobre o shape do Unit of Work: cada fluxo (ProcessWagerTransaction,
 *  CreateWallet, ...) declara só as capabilities que realmente usa — nunca um
 *  UoW "canhão" com repositórios que o use case não toca (ex.: inbox não
 *  participa da criação de wallet). O mecanismo por baixo (em.transactional())
 *  é o mesmo para todos; só muda o que é instanciado dentro de cada `run()`. */
export interface TransactionRunner<TUnitOfWork> {
  run<T>(work: (uow: TUnitOfWork) => Promise<T>): Promise<T>;
}
