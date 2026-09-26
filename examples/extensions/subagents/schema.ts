import type { JsonSchema } from "./workflow-types.js";

const SCHEMA_KEYS = new Set(["type", "enum", "properties", "items", "required", "const", "anyOf"]);

// Shorthand: a plain map of property -> schema means an object with all of them required.
export function normalizeSchema(schema: JsonSchema): JsonSchema {
  if (Object.keys(schema).some(k => SCHEMA_KEYS.has(k))) return schema;
  return { type: "object", properties: schema, required: Object.keys(schema) };
}

/** Returns a description of the first mismatch, or null when the value fits. */
export function validate(value: unknown, schema: JsonSchema, at = "$"): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some(e => e === value)) {
    return `${at} must be one of ${JSON.stringify(schema.enum)}`;
  }
  if ("const" in schema && schema.const !== value) return `${at} must be ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => validate(value, s as JsonSchema, at) === null)) {
    return `${at} matches none of anyOf`;
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some(t => hasType(value, String(t)))) return `${at} must be ${types.join(" or ")}`;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) return `${at}.${key} is required`;
    }
    for (const [key, sub] of Object.entries((schema.properties as Record<string, JsonSchema> | undefined) ?? {})) {
      if (key in obj) {
        const err = validate(obj[key], sub, `${at}.${key}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(value[i], schema.items as JsonSchema, `${at}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

/** Parses the JSON value in a model reply, tolerating code fences and surrounding prose. */
export function parseJsonReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  try { return JSON.parse(body); } catch {}
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
  throw new Error("reply contained no JSON");
}
