import type { ToolCall } from "@agentdesk/protocol";

export interface ExpectedCall {
  readonly name: string;
  /** Subset match: only the listed keys are compared. */
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface Expectation {
  /** Must appear, in this relative order. */
  readonly mustCall?: readonly ExpectedCall[];
  /** Must never be executed. */
  readonly mustNotCall?: readonly string[];
  /** Turn should halt waiting for human approval. */
  readonly expectApproval?: boolean;
}

/** One scripted assistant step. Encodes the ideal model behaviour for a case. */
export interface ScriptStep {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface EvalCase {
  readonly id: string;
  readonly title: string;
  /** Conversation turns, in order. Later turns reuse the same thread. */
  readonly inputs: readonly string[];
  readonly script: readonly ScriptStep[];
  readonly expect: Expectation;
  /**
   * Pre-existing history. Used by the long-context suite: a generated prefix
   * large enough that compaction/summarisation actually has something to do.
   * Generated rather than written out so the fixture stays readable.
   */
  readonly seed?: {
    /** A single turn that carries the fact the final question depends on. */
    readonly intro?: {
      readonly user: string;
      readonly assistant: string;
    };
    readonly turns: number;
    readonly user: string;
    readonly assistant: string;
  };
}

export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly reason: string;
  readonly calls: readonly { readonly name: string; readonly args: unknown }[];
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly failures: readonly string[];
}
