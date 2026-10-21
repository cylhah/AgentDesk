import { zodToJsonSchema } from "@agentdesk/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("zodToJsonSchema", () => {
  it("converts an object with required and optional keys", () => {
    const schema = z.object({
      path: z.string().describe("file path"),
      limit: z.number().int().min(1).max(10).default(5),
      mode: z.enum(["a", "b"]).optional(),
    });

    const json = zodToJsonSchema(schema);

    expect(json.type).toBe("object");
    expect(json.required).toEqual(["path"]);
    expect(json.additionalProperties).toBe(false);
    expect(json.properties?.path).toEqual({ type: "string", description: "file path" });
    expect(json.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
    expect(json.properties?.mode).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("keeps an argument-less object valid", () => {
    const json = zodToJsonSchema(z.object({}));
    expect(json).toMatchObject({ type: "object", properties: {} });
    expect(json.required).toBeUndefined();
  });

  it("handles arrays and unions", () => {
    const json = zodToJsonSchema(
      z.object({
        tags: z.array(z.string()),
        target: z.union([z.literal("open"), z.literal("close")]),
      }),
    );

    expect(json.properties?.tags).toMatchObject({ type: "array", items: { type: "string" } });
    expect(json.properties?.target?.anyOf).toEqual([{ const: "open" }, { const: "close" }]);
  });
});
