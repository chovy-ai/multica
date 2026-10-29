// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { SETTINGS_OPERATIONS } from "./operations";

const daemonCopy = join(__dirname, "../../../server/internal/localconversation/settings/operations.json");

/** Objects that must name at least one field are refined in zod; JSON Schema states it directly. */
function requireFields(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(requireFields);
  if (!schema || typeof schema !== "object") return schema;
  const node = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, requireFields(value)]));
  const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
  for (const key of ["fields", "preferences"]) if (properties?.[key]?.type === "object") properties[key] = { ...properties[key], minProperties: 1 };
  return node;
}

function exported() {
  return SETTINGS_OPERATIONS.map(({ name, domain, description, permission, write, confirm, schema }) => ({
    name, domain, description, permission, write, confirm,
    input_schema: requireFields(z.toJSONSchema(z.object(schema).strict(), { io: "input", unrepresentable: "any" })),
  }));
}

it("gives the daemon the Settings operations the GUI and CLI use", () => {
  const text = `${JSON.stringify(exported(), null, 2)}\n`;
  if (process.env.UPDATE_SETTINGS_OPERATIONS === "1") writeFileSync(daemonCopy, text);
  expect(readFileSync(daemonCopy, "utf8")).toBe(text);
});
