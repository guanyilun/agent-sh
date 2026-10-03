import type { JsonSchema } from "./workflow-types.js";

const TYPES = new Set(["string", "number", "integer", "boolean"]);

export function normalizeSchema(schema: JsonSchema | string | unknown[]): JsonSchema {
  if (typeof schema === "string") return field(schema).schema;
  if (Array.isArray(schema)) return { type: "array", items: normalizeSchema(schema[0] as JsonSchema) };
  if (isJsonSchema(schema)) return schema;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const { schema: sub, optional } = typeof value === "string" ? field(value)
      : { schema: normalizeSchema(value as JsonSchema), optional: false };
    properties[key] = sub;
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required };
}

// Only a map that really looks like JSON Schema counts as one, so shorthand fields may be named items, required, ...
function isJsonSchema(o: JsonSchema): boolean {
  const t = o.type;
  return typeof t === "string" || (Array.isArray(t) && t.every(x => typeof x === "string"))
    || Array.isArray(o.enum) || Array.isArray(o.anyOf) || "const" in o;
}

function field(spec: string): { schema: JsonSchema; optional: boolean } {
  let s = spec.trim();
  const optional = s.endsWith("?");
  if (optional) s = s.slice(0, -1).trim();
  if (s.endsWith("[]")) return { schema: { type: "array", items: field(s.slice(0, -2)).schema }, optional };
  if (TYPES.has(s)) return { schema: { type: s }, optional };
  const choices = s.split("|").map(c => c.trim()).filter(Boolean);
  if (choices.length > 1 && choices.every(c => TYPES.has(c))) return { schema: { type: choices }, optional };
  if (choices.length > 1 || /^[\w-]+$/.test(s)) return { schema: { enum: choices }, optional };
  throw new Error(`can't read schema shorthand "${spec}"; use string, number, integer, boolean, "a | b", a [] suffix, or JSON Schema`);
}

export function example(schema: JsonSchema, name = "text"): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return example(schema.anyOf[0] as JsonSchema, name);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    return Object.fromEntries(Object.entries((schema.properties as Record<string, JsonSchema>) ?? {}).map(([k, v]) => [k, example(v, k)]));
  }
  if (type === "array") return [example((schema.items as JsonSchema) ?? {}, name)];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  return `<${name}>`;
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
