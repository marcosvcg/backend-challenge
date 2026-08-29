/**
 * Provisório: string genérica até implementarmos as regras de BET/WIN/REFUND/ROLLBACK,
 * quando levantaremos os códigos reais e substituiremos por uma literal union documentada
 * (seção 7.2 do README — taxonomia de failure codes é decisão nossa).
 */
export type FailureCode = string;
