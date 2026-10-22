import { isRecord } from "../shared/utils.ts";

/** One function of the sandbox's `tools` API. */
export interface ToolDeclaration {
  /** The JavaScript identifier the code calls it by: `tools.<identifier>(args)`. */
  identifier: string;
  description: string;
  /** JSON Schema of its single `args` object. */
  parameters: Record<string, unknown>;
  /** JSON Schema of what it resolves to; without one, it resolves to text. */
  outputSchema?: Record<string, unknown>;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Maps tool names onto unique JavaScript identifiers, so the code can write
 * `tools.demo__get_weather(...)` rather than `tools["demo-x"](...)`.
 */
export function toIdentifiers(names: string[]): Map<string, string> {
  const identifiers = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const base = name.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^(?=[0-9])/, "_") || "tool";
    let candidate = base;
    for (let counter = 2; used.has(candidate); counter += 1) {
      candidate = `${base}_${counter}`;
    }
    used.add(candidate);
    identifiers.set(name, candidate);
  }
  return identifiers;
}

/**
 * TypeScript declarations of the `tools` object the sandboxed code calls,
 * generated from each tool's JSON Schemas. Models read TypeScript far more
 * reliably than raw JSON Schema, and it's the form they write calls in. The
 * type is a named interface so a type error says `Tools`, not the whole shape.
 */
export function declareTools(tools: ToolDeclaration[]): string {
  return ["interface Tools {", ...tools.map(declareTool), "}", "declare const tools: Tools;"].join(
    "\n",
  );
}

/** One member of the `Tools` interface, with its doc comment. */
export function declareTool(tool: ToolDeclaration): string {
  const required = Array.isArray(tool.parameters.required) && tool.parameters.required.length > 0;
  const args = schemaToType(tool.parameters, 1);
  const returns = tool.outputSchema ? schemaToType(tool.outputSchema, 1) : "string";
  return [
    docComment(tool.description, 1),
    `  ${tool.identifier}(args${required ? "" : "?"}: ${args}): Promise<${returns}>;`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A JSON Schema (the subset tool parameters use) as a TypeScript type. */
export function schemaToType(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) {
    return "unknown";
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return union(schema.enum.map(literal));
  }
  if ("const" in schema) {
    return literal(schema.const);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (Array.isArray(variants) && variants.length > 0) {
      return union(variants.map((variant) => schemaToType(variant, depth)));
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((part) => wrap(schemaToType(part, depth))).join(" & ");
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return union(type.map((single) => schemaToType({ ...schema, type: single }, depth)));
  }

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return arrayType(schema, depth);
    case "object":
      return objectType(schema, depth);
    default:
      return isRecord(schema.properties) ? objectType(schema, depth) : "unknown";
  }
}

function arrayType(schema: Record<string, unknown>, depth: number): string {
  const items = schema.items ?? schema.prefixItems;
  if (Array.isArray(items)) {
    return `[${items.map((item) => schemaToType(item, depth)).join(", ")}]`;
  }
  return `${wrap(schemaToType(items, depth))}[]`;
}

function objectType(schema: Record<string, unknown>, depth: number): string {
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const extra = schema.additionalProperties;

  if (properties.length === 0) {
    if (extra === false) {
      return "{}";
    }
    return `Record<string, ${isRecord(extra) ? schemaToType(extra, depth) : "unknown"}>`;
  }

  const indent = "  ".repeat(depth + 1);
  const lines = properties.map(([name, property]) => {
    const description = isRecord(property) ? propertyDescription(property) : undefined;
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    const optional = required.has(name) ? "" : "?";
    return [
      docComment(description, depth + 1),
      `${indent}${key}${optional}: ${schemaToType(property, depth + 1)};`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  if (isRecord(extra)) {
    lines.push(`${indent}[key: string]: ${schemaToType(extra, depth + 1)};`);
  }
  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

function propertyDescription(property: Record<string, unknown>): string | undefined {
  const parts = [
    typeof property.description === "string" ? property.description : undefined,
    "default" in property ? `Default: ${JSON.stringify(property.default)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function docComment(text: string | undefined, depth: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const indent = "  ".repeat(depth);
  // `*/` would end the comment early.
  const lines = trimmed.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) {
    return `${indent}/** ${lines[0]} */`;
  }
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join("\n");
}

function literal(value: unknown): string {
  return JSON.stringify(value) ?? "unknown";
}

function union(types: string[]): string {
  const unique = [...new Set(types)];
  return unique.includes("unknown") ? "unknown" : unique.join(" | ");
}

/** Parenthesizes a union or intersection so `[]` / `&` bind to the whole type. */
function wrap(type: string): string {
  let nesting = 0;
  for (const char of type) {
    if ("{[(<".includes(char)) {
      nesting += 1;
    } else if ("}])>".includes(char)) {
      nesting -= 1;
    } else if (nesting === 0 && (char === "|" || char === "&")) {
      return `(${type})`;
    }
  }
  return type;
}
