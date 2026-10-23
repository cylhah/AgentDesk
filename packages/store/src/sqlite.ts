import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Message, TurnEndReason } from "@agentdesk/protocol";
import type {
  CreateSessionInput,
  LoadedSession,
  SessionHeader,
  SessionStore,
  SessionSummary,
  StoredTurn,
  TurnUsage,
} from "./types";

/**
 * Vite/Vitest does not list `node:sqlite` among its known builtins, so a static
 * `import ... from "node:sqlite"` gets rewritten to a bare "sqlite" package and
 * fails at test time. Going through Node's own resolver keeps `tsx` and `vitest`
 * on the same code path.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const THREAD_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * SQLite session store, built on Node's built-in `node:sqlite` — no native
 * dependency, no install step on Windows.
 *
 * What SQLite buys over NDJSON: turn/message queries for the dashboard
 * (`sessions`, per-turn usage), one file instead of N, and a place to put the
 * `items` projection when the UI needs paging. What it costs: the file is no
 * longer greppable or hand-editable, which is why the JSONL store stays.
 */
export class SqliteSessionStore implements SessionStore {
  readonly file: string;
  private readonly db: import("node:sqlite").DatabaseSync;

  constructor(file = resolve(process.cwd(), "runs/sessions/sessions.db")) {
    this.file = resolve(file);
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id  TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        cwd        TEXT NOT NULL,
        provider   TEXT NOT NULL,
        system     TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id    TEXT NOT NULL REFERENCES sessions(thread_id) ON DELETE CASCADE,
        turn_id      TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_calls   TEXT,
        tool_call_id TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(thread_id, id);
      CREATE TABLE IF NOT EXISTS turns (
        thread_id    TEXT NOT NULL REFERENCES sessions(thread_id) ON DELETE CASCADE,
        turn_id      TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        reason       TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        steps        INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );
    `);
  }

  describe(): string {
    return this.file;
  }

  close(): void {
    this.db.close();
  }

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    if (!THREAD_ID.test(input.threadId)) {
      throw new Error(`invalid threadId: ${JSON.stringify(input.threadId)}`);
    }
    const createdAt = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (thread_id, created_at, cwd, provider, system)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.threadId, createdAt, input.cwd, input.provider, input.system ?? null);
    // The DB stores the system prompt because it is part of the experiment:
    // resuming must replay the policy the transcript was produced with.
    return {
      v: 1,
      type: "session",
      threadId: input.threadId,
      createdAt,
      cwd: input.cwd,
      provider: input.provider,
      ...(input.system !== undefined ? { system: input.system } : {}),
    };
  }

  async appendMessage(threadId: string, turnId: string, message: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (thread_id, turn_id, ts, role, content, tool_calls, tool_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        turnId,
        Date.now(),
        message.role,
        message.content,
        message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
        message.toolCallId ?? null,
      );
  }

  async appendTurn(
    threadId: string,
    turn: { turnId: string; reason: TurnEndReason; usage: TurnUsage },
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO turns (thread_id, turn_id, ts, reason, input_tokens, output_tokens, steps)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        turn.turnId,
        Date.now(),
        turn.reason,
        turn.usage.inputTokens,
        turn.usage.outputTokens,
        turn.usage.steps,
      );
  }

  async load(threadId: string): Promise<LoadedSession> {
    const session = this.db
      .prepare(
        `SELECT thread_id, created_at, cwd, provider, system FROM sessions WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { thread_id: string; created_at: number; cwd: string; provider: string; system: string | null }
      | undefined;

    if (session === undefined) {
      throw new Error(`no such session: ${threadId} (not in ${this.file})`);
    }

    const messageRows = this.db
      .prepare(
        `SELECT role, content, tool_calls, tool_call_id FROM messages
         WHERE thread_id = ? ORDER BY id`,
      )
      .all(threadId) as {
      role: Message["role"];
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
    }[];

    const turnRows = this.db
      .prepare(
        `SELECT turn_id, ts, reason, input_tokens, output_tokens, steps FROM turns
         WHERE thread_id = ? ORDER BY ts, rowid`,
      )
      .all(threadId) as {
      turn_id: string;
      ts: number;
      reason: TurnEndReason;
      input_tokens: number;
      output_tokens: number;
      steps: number;
    }[];

    const header: SessionHeader = {
      v: 1,
      type: "session",
      threadId: session.thread_id,
      createdAt: session.created_at,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.system !== null ? { system: session.system } : {}),
    };

    const messages: Message[] = messageRows.map((row) => {
      const message: Message = {
        role: row.role,
        content: row.content,
      };
      return {
        ...message,
        ...(row.tool_calls !== null
          ? { toolCalls: JSON.parse(row.tool_calls) as NonNullable<Message["toolCalls"]> }
          : {}),
        ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
      };
    });

    const turns: StoredTurn[] = turnRows.map((row) => ({
      v: 1,
      type: "turn",
      ts: row.ts,
      turnId: row.turn_id,
      reason: row.reason,
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        steps: row.steps,
      },
    }));

    return { header, messages, turns, skippedLines: 0 };
  }

  async list(): Promise<SessionSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT s.thread_id, s.created_at, s.provider,
                (SELECT COUNT(*) FROM messages m WHERE m.thread_id = s.thread_id) AS messages,
                (SELECT COUNT(*) FROM turns t WHERE t.thread_id = s.thread_id) AS turns,
                COALESCE(
                  (SELECT MAX(ts) FROM messages m2 WHERE m2.thread_id = s.thread_id),
                  (SELECT MAX(ts) FROM turns t2 WHERE t2.thread_id = s.thread_id),
                  s.created_at
                ) AS updated_at,
                COALESCE(
                  (SELECT m3.content FROM messages m3
                   WHERE m3.thread_id = s.thread_id AND m3.role = 'user'
                   ORDER BY m3.id LIMIT 1),
                  '(empty)'
                ) AS first_user
         FROM sessions s
         ORDER BY updated_at DESC`,
      )
      .all() as {
      thread_id: string;
      created_at: number;
      provider: string;
      messages: number;
      turns: number;
      updated_at: number;
      first_user: string;
    }[];

    return rows.map((row) => ({
      threadId: row.thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: row.messages,
      turns: row.turns,
      provider: row.provider,
      firstUserText: row.first_user,
    }));
  }
}
