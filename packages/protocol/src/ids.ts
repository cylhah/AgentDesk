import { randomUUID } from "node:crypto";

/** Stable, prefixed ids so that logs and traces are greppable. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function now(): number {
  return Date.now();
}

/** Rough token estimate: ~4 chars per token for mixed English/code. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
