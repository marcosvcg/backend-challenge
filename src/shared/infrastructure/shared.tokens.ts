/** Tokens de DI do Nest para as portas compartilhadas de application
 *  (IdGenerator, Clock) — interfaces puras, o Nest não resolve por tipo
 *  estrutural, então cada uma precisa de um token concreto para ser injetável. */
export const ID_GENERATOR = Symbol('IdGenerator');
export const CLOCK = Symbol('Clock');
