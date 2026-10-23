import type { z } from "zod";

/**
 * Minimal zod(v3) -> JSON Schema converter, scoped to what tool definitions
 * actually use. zod 3.x ships no public converter (the v4 line does), and
 * pulling a third-party lib for ~15 cases is not worth the dependency.
 *
 * Unsupported constructs throw instead of silently emitting `{}` — a wrong
 * schema means the model never sees the argument descriptions, and that bug is
 * invisible until a tool call fails for no apparent reason.
 */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

type AnyDef = {
  typeName?: string;
  type?: unknown;
  checks?: { kind: string; value?: number }[];
  values?: unknown[];
  value?: unknown;
  defaultValue?: unknown;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  typeNameOverride?: string;
  options?: z.ZodTypeAny[];
  valueType?: z.ZodTypeAny;
};

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as unknown as { _def: AnyDef })._def;
  if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable") {
    return def.innerType ?? schema;
  }
  if (def.typeName === "ZodDefault") {
    return def.innerType ?? schema;
  }
  if (def.typeName === "ZodEffects") {
    return def.schema ?? schema;
  }
  return schema;
}

function isOptionalKey(schema: z.ZodTypeAny): boolean {
  const def = (schema as unknown as { _def: AnyDef })._def;
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") return true;
  if (def.typeName === "ZodEffects" && def.schema !== undefined) {
    return isOptionalKey(def.schema);
  }
  return false;
}

function withDescription(target: JsonSchema, schema: z.ZodTypeAny): JsonSchema {
  return schema.description === undefined
    ? target
    : { ...target, description: schema.description };
}

export function zodToJsonSchema(input: z.ZodTypeAny): JsonSchema {
  return applyWrapperMetadata(convert(input), input);
}

/**
 * `z.string().optional().describe("x")` puts both the description and the
 * default on the *wrapper*, but `convert` unwraps to the inner type first — so
 * these would silently disappear from the schema the model sees. Read them
 * from the original schema. (Found by dumping the real request body: every
 * optional argument of `search_media` had lost its description.)
 */
function applyWrapperMetadata(schema: JsonSchema, input: z.ZodTypeAny): JsonSchema {
  const def = (input as unknown as { _def: AnyDef })._def;
  let result = schema;

  if (input.description !== undefined) {
    result = { ...result, description: input.description };
  }

  if (def.typeName === "ZodDefault") {
    const value =
      typeof def.defaultValue === "function"
        ? (def.defaultValue as () => unknown)()
        : def.defaultValue;
    if (value !== undefined) result = { ...result, default: value };
  }

  return result;
}

function convert(input: z.ZodTypeAny): JsonSchema {
  const schema = unwrap(input);
  const def = (schema as unknown as { _def: AnyDef })._def;

  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptionalKey(child)) required.push(key);
      }

      const result: JsonSchema = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) result.required = required;
      return withDescription(result, schema);
    }

    case "ZodString": {
      const result: JsonSchema = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min" && typeof check.value === "number") {
          result.minLength = check.value;
        }
        if (check.kind === "max" && typeof check.value === "number") {
          result.maxLength = check.value;
        }
      }
      return withDescription(result, schema);
    }

    case "ZodNumber": {
      const isInt = (def.checks ?? []).some((check) => check.kind === "int");
      const result: JsonSchema = { type: isInt ? "integer" : "number" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min" && typeof check.value === "number") {
          result.minimum = check.value;
        }
        if (check.kind === "max" && typeof check.value === "number") {
          result.maximum = check.value;
        }
      }
      return withDescription(result, schema);
    }

    case "ZodBoolean":
      return withDescription({ type: "boolean" }, schema);

    case "ZodEnum":
      return withDescription({ type: "string", enum: def.values ?? [] }, schema);

    case "ZodLiteral":
      return withDescription({ const: def.value }, schema);

    case "ZodArray":
      return withDescription(
        { type: "array", items: zodToJsonSchema(def.type as z.ZodTypeAny) },
        schema,
      );

    case "ZodUnion":
      return withDescription(
        { anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)) },
        schema,
      );

    case "ZodRecord":
      return withDescription(
        {
          type: "object",
          additionalProperties: zodToJsonSchema(def.valueType as z.ZodTypeAny),
        },
        schema,
      );

    case "ZodAny":
    case "ZodUnknown":
      return withDescription({}, schema);

    default:
      throw new Error(`zodToJsonSchema: unsupported zod type "${def.typeName ?? "?"}"`);
  }
}
