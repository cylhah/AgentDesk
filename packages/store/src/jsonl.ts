import { appendFile, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message, TurnEndReason } from "@agentdesk/protocol";
import type {
  CreateSessionInput,
  LoadedSession,
  SessionHeader,
  SessionLine,
  SessionStore,
  SessionSummary,
  StoredMessage,
  StoredTurn,
  TurnUsage,
} from "./types";

const THREAD_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Append-only NDJSON session log, one file per thread.
 *
 * Why NDJSON stays around after SQLite lands: it is greppable, append-only and
 * crash-tolerant (a torn last line loses one message, not the session). Both
 * implementations satisfy `SessionStore`, so `resume` behaves identically.
 */
export class JsonlSessionStore implements SessionStore {
  readonly root: string;

  constructor(root = resolve(process.cwd(), "runs/sessions")) {
    this.root = resolve(root);
  }

  fileFor(threadId: string): string {
    if (!THREAD_ID.test(threadId)) {
      throw new Error(`invalid threadId: ${JSON.stringify(threadId)}`);
    }
    return join(this.root, `${threadId}.jsonl`);
  }

  /** No-op: the OS owns the file handle here; kept so both stores share a signature. */
  close(): void {}

  describe(): string {
    return this.root;
  }

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true });
    const header: SessionHeader = {
      v: 1,
      type: "session",
      threadId: input.threadId,
      createdAt: input.now ?? Date.now(),
      cwd: input.cwd,
      provider: input.provider,
      ...(input.system !== undefined ? { system: input.system } : {}),
    };
    await this.appendLine(this.fileFor(input.threadId), header);
    return header;
  }

  async appendMessage(threadId: string, turnId: string, message: Message): Promise<void> {
    const line: StoredMessage = {
      v: 1,
      type: "message",
      ts: Date.now(),
      turnId,
      message,
    };
    await this.appendLine(this.fileFor(threadId), line);
  }

  async appendTurn(
    threadId: string,
    turn: { turnId: string; reason: TurnEndReason; usage: TurnUsage },
  ): Promise<void> {
    const line: StoredTurn = {
      v: 1,
      type: "turn",
      ts: Date.now(),
      turnId: turn.turnId,
      reason: turn.reason,
      usage: turn.usage,
    };
    await this.appendLine(this.fileFor(threadId), line);
  }

  async load(threadId: string): Promise<LoadedSession> {
    const file = this.fileFor(threadId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error(`no such session: ${threadId} (expected ${file})`);
    }

    let header: SessionHeader | undefined;
    const messages: Message[] = [];
    const turns: StoredTurn[] = [];
    let latestSummary: { text: string; frontier: number } | undefined;
    let skippedLines = 0;

    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: SessionLine;
      try {
        parsed = JSON.parse(line) as SessionLine;
      } catch {
        skippedLines += 1;
        continue;
      }
      switch (parsed.type) {
        case "session":
          header ??= parsed;
          break;
        case "message":
          messages.push(parsed.message);
          break;
        case "turn":
          turns.push(parsed);
          break;
        case "summary":
          // Last summary wins: it covers a longer prefix than the previous one.
          latestSummary = { text: parsed.text, frontier: parsed.frontier };
          break;
        default:
          skippedLines += 1;
      }
    }

    if (header === undefined) {
      throw new Error(`session ${threadId} has no header line — file is corrupt`);
    }
    return {
      header,
      messages,
      turns,
      ...(latestSummary !== undefined ? { summary: latestSummary } : {}),
      skippedLines,
    };
  }

  async saveSummary(threadId: string, summary: { text: string; frontier: number }): Promise<void> {
    await this.appendLine(this.fileFor(threadId), {
      v: 1,
      type: "summary",
      ts: Date.now(),
      text: summary.text,
      frontier: summary.frontier,
    });
  }

  async list(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = (await readdir(this.root)).filter((file) => file.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const threadId = file.slice(0, -".jsonl".length);
      try {
        const loaded = await this.load(threadId);
        const info = await stat(join(this.root, file));
        const firstUser = loaded.messages.find((message) => message.role === "user");
        summaries.push({
          threadId,
          createdAt: loaded.header.createdAt,
          updatedAt: info.mtimeMs,
          messages: loaded.messages.length,
          turns: loaded.turns.length,
          provider: loaded.header.provider,
          firstUserText: firstUser?.content ?? "(empty)",
        });
      } catch {
        // Ignore unreadable files; a half-written session should not break `sessions`.
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async appendLine(file: string, line: SessionLine): Promise<void> {
    // A crash can leave a line without its trailing newline. Starting the next
    // record on a fresh line keeps the damage to that one record instead of
    // gluing two records together and losing both. Checked per append, not
    // cached: another process (or a test) may have written in between.
    const prefix = (await this.hasCleanTail(file)) ? "" : "\n";
    await appendFile(file, `${prefix}${JSON.stringify(line)}\n`, "utf8");
  }

  private async hasCleanTail(file: string): Promise<boolean> {
    try {
      const handle = await open(file, "r");
      try {
        const { size } = await handle.stat();
        if (size === 0) return true;
        const byte = Buffer.alloc(1);
        await handle.read(byte, 0, 1, size - 1);
        return byte.toString("utf8") === "\n";
      } finally {
        await handle.close();
      }
    } catch {
      return true; // file does not exist yet
    }
  }
}
