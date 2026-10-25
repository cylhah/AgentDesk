import { z } from "zod";
import { RiskLevelSchema } from "./tools";

export const TurnEndReasonSchema = z.enum([
  "completed",
  "max_steps",
  "budget_exceeded",
  "aborted",
  "error",
  "awaiting_approval",
]);
export type TurnEndReason = z.infer<typeof TurnEndReasonSchema>;

const base = {
  turnId: z.string(),
  ts: z.number().int().nonnegative(),
};

/**
 * The single wire format between runtime and every host
 * (CLI today; Electron / WebSocket gateway later).
 * Adding a variant here forces every consumer to handle it — that is the point.
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.start"), ...base }),
  z.object({ type: z.literal("turn.end"), ...base, reason: TurnEndReasonSchema }),
  z.object({ type: z.literal("message.delta"), ...base, text: z.string() }),
  z.object({ type: z.literal("message.complete"), ...base, text: z.string() }),
  z.object({
    type: z.literal("tool.call"),
    ...base,
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool.result"),
    ...base,
    callId: z.string(),
    ok: z.boolean(),
    output: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("turn.persisted"),
    ...base,
    reason: TurnEndReasonSchema,
  }),
  z.object({
    type: z.literal("tool.approval_required"),
    ...base,
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
    risk: RiskLevelSchema,
  }),
  z.object({
    type: z.literal("tool.approval_resolved"),
    ...base,
    callId: z.string(),
    name: z.string(),
    decision: z.enum(["approve", "deny"]),
  }),
  z.object({
    type: z.literal("usage"),
    ...base,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    /** "api" = reported by the endpoint; "estimate" = chars/4 fallback (scripted providers, older endpoints). */
    source: z.enum(["api", "estimate"]).optional(),
  }),
  z.object({
    type: z.literal("context.compacted"),
    ...base,
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    truncatedToolResults: z.number().int().nonnegative(),
    elidedToolResults: z.number().int().nonnegative(),
    droppedMessages: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("context.summarized"),
    ...base,
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    summarizedMessages: z.number().int().nonnegative(),
    keptMessages: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    ...base,
    message: z.string(),
    recoverable: z.boolean(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent["type"];
