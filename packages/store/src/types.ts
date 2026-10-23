import type { Message, TurnEndReason } from "@agentdesk/protocol";

export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps: number;
}

/**
 * First line of every session file.
 *
 * `system` is stored on purpose: the scenario policy is part of what produced
 * the transcript, so resuming must replay the same policy rather than today's
 * default. Changing the prompt is a change to the experiment.
 */
export interface SessionHeader {
  readonly v: 1;
  readonly type: "session";
  readonly threadId: string;
  readonly createdAt: number;
  readonly cwd: string;
  readonly provider: string;
  readonly system?: string;
}

/** One canonical message, appended in the order the loop produced it. */
export interface StoredMessage {
  readonly v: 1;
  readonly type: "message";
  readonly ts: number;
  readonly turnId: string;
  readonly message: Message;
}

export interface StoredTurn {
  readonly v: 1;
  readonly type: "turn";
  readonly ts: number;
  readonly turnId: string;
  readonly reason: TurnEndReason;
  readonly usage: TurnUsage;
}

export interface StoredSummaryLine {
  readonly v: 1;
  readonly type: "summary";
  readonly ts: number;
  readonly text: string;
  readonly frontier: number;
}

export type SessionLine = SessionHeader | StoredMessage | StoredTurn | StoredSummaryLine;

export interface LoadedSession {
  readonly header: SessionHeader;
  readonly messages: readonly Message[];
  readonly turns: readonly StoredTurn[];
  /** Latest semantic summary of the head of the conversation, if one was saved. */
  readonly summary?: StoredSummary;
  /** Lines that failed to parse — tolerated so one bad write cannot lose a session. */
  readonly skippedLines: number;
}

/**
 * A summary replaces `messages[0..frontier]` in requests only.
 * Stored because recomputing it every turn costs a full extra request.
 */
export interface StoredSummary {
  readonly text: string;
  /** Number of messages covered; the log is append-only, so this index stays valid. */
  readonly frontier: number;
}

export interface SessionSummary {
  readonly threadId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: number;
  readonly turns: number;
  readonly provider: string;
  readonly firstUserText: string;
}

export interface CreateSessionInput {
  readonly threadId: string;
  readonly cwd: string;
  readonly provider: string;
  readonly system?: string;
  readonly now?: number;
}

/**
 * The seam between "how a session is stored" and everything else.
 *
 * Two implementations exist on purpose (NDJSON, SQLite) and share one contract
 * test, so swapping storage cannot silently change what `resume` sees.
 */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionHeader>;
  appendMessage(threadId: string, turnId: string, message: Message): Promise<void>;
  appendTurn(
    threadId: string,
    turn: { turnId: string; reason: TurnEndReason; usage: TurnUsage },
  ): Promise<void>;
  load(threadId: string): Promise<LoadedSession>;
  /** Replaces any previous summary for the thread. */
  saveSummary(threadId: string, summary: StoredSummary): Promise<void>;
  list(): Promise<SessionSummary[]>;
  /** Human-readable location, printed by the CLI (`sessions`/`run`). */
  describe(): string;
  close(): void;
}
