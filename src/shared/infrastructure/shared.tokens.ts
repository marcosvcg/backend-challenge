/** Tokens de DI do Nest para as portas compartilhadas de application
 *  (IdGenerator, Clock, MetricsPort, Logger) — interfaces puras, o Nest não
 *  resolve por tipo estrutural, então cada uma precisa de um token concreto
 *  para ser injetável. */
export const ID_GENERATOR = Symbol('IdGenerator');
export const CLOCK = Symbol('Clock');
export const METRICS = Symbol('MetricsPort');
export const LOGGER = Symbol('Logger');
