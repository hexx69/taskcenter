import { describe, expect, it } from "vitest";
import type { MemoryProviderDescriptor } from "@paperclipai/shared";
import {
  getMemoryConfigFields,
  getSuggestedMemoryConfig,
  parseMemoryConfigJson,
  validateMemoryProviderConfig,
} from "./memory-config-schema";

const provider: MemoryProviderDescriptor = {
  key: "qmd_memory",
  displayName: "QMD Memory",
  description: "Markdown memory",
  kind: "plugin",
  pluginId: "paperclip.qmd-memory",
  capabilities: {
    browse: true,
    correction: false,
    asyncIngestion: false,
    providerManagedExtraction: false,
  },
  configSchema: {
    type: "object",
    properties: {
      searchMode: { type: "string", enum: ["query", "search"], default: "query" },
      topK: { type: "integer", minimum: 1, maximum: 25, default: 5 },
      autoIndexOnWrite: { type: "boolean", default: true },
    },
  },
  configMetadata: {
    suggestedConfig: {
      searchMode: "query",
      topK: 5,
      autoIndexOnWrite: true,
    },
    fields: [
      {
        key: "searchMode",
        label: "Search mode",
        input: "select",
        options: [
          { value: "query", label: "Query" },
          { value: "search", label: "Search" },
        ],
      },
      {
        key: "topK",
        label: "Hydration snippets",
        input: "number",
        min: 1,
        max: 25,
      },
      {
        key: "autoIndexOnWrite",
        label: "Auto-index on write",
        input: "boolean",
      },
    ],
  },
};

describe("memory config schema helpers", () => {
  it("prefers provider metadata for form fields and suggested config", () => {
    expect(getMemoryConfigFields(provider).map((field) => field.label)).toEqual([
      "Search mode",
      "Hydration snippets",
      "Auto-index on write",
    ]);
    expect(getSuggestedMemoryConfig(provider)).toEqual({
      searchMode: "query",
      topK: 5,
      autoIndexOnWrite: true,
    });
  });

  it("returns field-specific validation errors", () => {
    const validation = validateMemoryProviderConfig(provider, {
      searchMode: "unknown",
      topK: 50,
      autoIndexOnWrite: "yes",
    });

    expect(validation.valid).toBe(false);
    expect(validation.fieldErrors).toEqual({
      searchMode: "Search mode must be one of the listed options.",
      topK: "Hydration snippets must be at most 25.",
      autoIndexOnWrite: "Auto-index on write must be on or off.",
    });
  });

  it("parses only JSON objects for advanced editing", () => {
    expect(parseMemoryConfigJson("{\"topK\":5}")).toEqual({ topK: 5 });
    expect(() => parseMemoryConfigJson("[]")).toThrow("Config must be a JSON object");
  });
});

