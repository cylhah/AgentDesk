import { randomUUID } from "node:crypto";

/** Stable, prefixed ids so that logs and traces are greppable. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function now(): number {
  return Date.now();
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // kana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK ext A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // hangul
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat
    (codePoint >= 0xff00 && codePoint <= 0xff60) // fullwidth forms
  );
}

/**
 * Rough token estimate, used only where the endpoint does not report usage
 * (scripted providers, context budgeting when a summary must be priced).
 *
 * Latin/code text is ~4 chars per token, but CJK is ~0.6–0.7 tokens *per char*:
 * naive `length / 4` underestimated a Chinese transcript by ~3× (estimated 7.3k,
 * billed 21k), which also meant budget thresholds never fired. Splitting the two
 * scripts is the cheapest fix that keeps the function dependency-free.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;

  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isCjk(codePoint)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(other / 4 + cjk * 0.65));
}
