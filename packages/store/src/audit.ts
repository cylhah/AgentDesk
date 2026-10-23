import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type AuditKind = "tool" | "approval" | "turn";

/**
 * One line per consequential action. The runtime stays unaware of this file:
 * the host derives it from the event stream plus its own decisions, so the
 * kernel does not grow an "ops" dependency.
 *
 * Why a separate log instead of the session file: an audit trail answers
 * "who did what, when, in which workspace, and was it approved" — it must be
 * readable without replaying prompts, and it should survive even if the
 * conversation is deleted.
 */
export interface AuditEntry {
  readonly v: 1;
  readonly ts: number;
  readonly threadId: string;
  readonly turnId?: string;
  readonly kind: AuditKind;
  readonly cwd?: string;
  readonly tool?: string;
  readonly risk?: string;
  readonly decision?: "auto" | "approved" | "denied";
  readonly ok?: boolean;
  readonly durationMs?: number;
  readonly args?: string;
  readonly reason?: string;
  readonly tokens?: { readonly input: number; readonly output: number };
}

export interface AuditFilter {
  readonly threadId?: string;
  /** Keep only the last N matching entries. */
  readonly limit?: number;
}

export class AuditLog {
  readonly file: string;

  constructor(file = resolve(process.cwd(), "runs/audit.ndjson")) {
    this.file = resolve(file);
  }

  async record(entry: Omit<AuditEntry, "v" | "ts"> & { readonly ts?: number }): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const line: AuditEntry = {
      v: 1,
      ts: entry.ts ?? Date.now(),
      ...entry,
    };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, "utf8");
  }

  async read(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }

    const entries: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (filter.threadId !== undefined && parsed.threadId !== filter.threadId) continue;
        entries.push(parsed);
      } catch {
        // A torn line must not hide the rest of the trail.
      }
    }

    return filter.limit === undefined ? entries : entries.slice(-filter.limit);
  }
}
