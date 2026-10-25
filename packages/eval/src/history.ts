import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface EvalCaseRecord {
  readonly id: string;
  readonly ok: boolean;
  readonly reason: string;
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly failures: readonly string[];
}

/**
 * One recorded eval run. History is append-only NDJSON so a bad run cannot
 * rewrite a good number, and so `git`-less diffing (or `tail`) works.
 *
 * The flags matter as much as the score: "5/5" from a 500-token context budget
 * is not the same claim as "5/5" from the default 32k.
 */
export interface EvalRunRecord {
  readonly v: 1;
  readonly ts: number;
  readonly model: string;
  readonly scenario: string;
  readonly live: boolean;
  readonly flags: {
    readonly suite?: string;
    readonly maxContextTokens?: number;
    readonly summarize?: boolean;
    readonly summarizeAtTokens?: number;
  };
  readonly cases: readonly EvalCaseRecord[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly durationMs: number;
    readonly p50Ms: number;
  };
}

export class EvalHistory {
  readonly file: string;

  constructor(file = resolve(process.cwd(), "runs/eval-history.ndjson")) {
    this.file = resolve(file);
  }

  async append(
    record: Omit<EvalRunRecord, "v" | "ts" | "summary"> & { readonly ts?: number },
  ): Promise<EvalRunRecord> {
    await mkdir(dirname(this.file), { recursive: true });

    const durations = record.cases.map((entry) => entry.durationMs).sort((a, b) => a - b);
    const p50Ms = durations.length === 0 ? 0 : (durations[Math.floor(durations.length / 2)] ?? 0);

    const full: EvalRunRecord = {
      v: 1,
      ts: record.ts ?? Date.now(),
      ...record,
      summary: {
        total: record.cases.length,
        passed: record.cases.filter((entry) => entry.ok).length,
        inputTokens: record.cases.reduce((sum, entry) => sum + entry.inputTokens, 0),
        outputTokens: record.cases.reduce((sum, entry) => sum + entry.outputTokens, 0),
        durationMs: record.cases.reduce((sum, entry) => sum + entry.durationMs, 0),
        p50Ms,
      },
    };

    await appendFile(this.file, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  async read(limit?: number): Promise<EvalRunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }

    const runs: EvalRunRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        runs.push(JSON.parse(line) as EvalRunRecord);
      } catch {
        // a torn line must not hide earlier history
      }
    }
    return limit === undefined ? runs : runs.slice(-limit);
  }
}
