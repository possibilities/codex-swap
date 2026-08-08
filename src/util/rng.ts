/**
 * Uniform [0, 1) random source, injectable so poll plans and backoff are
 * deterministic under test.
 */
export type Rng = () => number;

export const systemRng: Rng = () => Math.random();
