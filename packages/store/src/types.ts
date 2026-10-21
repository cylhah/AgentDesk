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

export type SessionLine = SessionHeader | StoredMessage | StoredTurn;

export interface LoadedSession {
  readonly header: SessionHeader;
  readonly messages: readonly Message[];
  readonly turns: readonly StoredTurn[];
  /** Lines that failed to parse — tolerated so one bad write cannot lose a session. */
  readonly skippedLines: number;
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
