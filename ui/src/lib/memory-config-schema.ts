import type {
  MemoryProviderConfigFieldMetadata,
  MemoryProviderDescriptor,
} from "@paperclipai/shared";

export type MemoryConfigValidation = {
  valid: boolean;
  fieldErrors: Record<string, string>;
  formError: string | null;
};

type JsonSchemaProperty = {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
};

type JsonSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypeIncludes(type: JsonSchemaProperty["type"], expected: string) {
  return Array.isArray(type) ? type.includes(expected) : type === expected;
}

function titleizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferInput(key: string, property: JsonSchemaProperty): MemoryProviderConfigFieldMetadata["input"] {
  const lowered = key.toLowerCase();
  if (property.enum?.length) return "select";
  if (schemaTypeIncludes(property.type, "boolean")) return "boolean";
  if (schemaTypeIncludes(property.type, "number") || schemaTypeIncludes(property.type, "integer")) return "number";
  if (lowered.includes("password") || lowered.includes("token") || lowered.includes("apikey") || lowered.includes("api_key")) {
    return "secret";
  }
  if (lowered.includes("path") || lowered.includes("dir")) return "path";
  return "text";
}

function schemaObject(provider: MemoryProviderDescriptor | undefined): JsonSchemaObject | null {
  const schema = provider?.configSchema;
  if (!isObject(schema)) return null;
  return schema as JsonSchemaObject;
}

export function getMemoryConfigFields(provider: MemoryProviderDescriptor | undefined) {
  const metadataFields = provider?.configMetadata?.fields;
  if (metadataFields?.length) return metadataFields;

  const schema = schemaObject(provider);
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, property]) => ({
    key,
    label: titleizeKey(key),
    description: property.description ?? null,
    input: inferInput(key, property),
    required: required.has(key),
    defaultValue: property.default,
    suggestedValue: property.default,
    min: property.minimum ?? null,
    max: property.maximum ?? null,
    options: property.enum?.map((value) => ({
      value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
        ? value
        : String(value),
      label: value === null ? "None" : titleizeKey(String(value)),
    })),
  } satisfies MemoryProviderConfigFieldMetadata));
}

export function getSuggestedMemoryConfig(provider: MemoryProviderDescriptor | undefined): Record<string, unknown> {
  if (provider?.configMetadata?.suggestedConfig) {
    return { ...provider.configMetadata.suggestedConfig };
  }

  const result: Record<string, unknown> = {};
  for (const field of getMemoryConfigFields(provider)) {
    if (field.suggestedValue !== undefined) {
      result[field.key] = field.suggestedValue;
    } else if (field.defaultValue !== undefined) {
      result[field.key] = field.defaultValue;
    }
  }
  return result;
}

export function prettyMemoryConfig(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

export function parseMemoryConfigJson(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Config must be valid JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("Config must be a JSON object");
  }
  return parsed;
}

function isBlank(value: unknown) {
  return value === undefined || value === null || value === "";
}

function allowedOptionValue(field: MemoryProviderConfigFieldMetadata, value: unknown) {
  return (field.options ?? []).some((option) => option.value === value);
}

export function validateMemoryProviderConfig(
  provider: MemoryProviderDescriptor | undefined,
  config: Record<string, unknown>,
): MemoryConfigValidation {
  const fieldErrors: Record<string, string> = {};

  for (const field of getMemoryConfigFields(provider)) {
    const value = config[field.key];

    if (field.required && isBlank(value)) {
      fieldErrors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (isBlank(value)) continue;

    if (field.input === "boolean" && typeof value !== "boolean") {
      fieldErrors[field.key] = `${field.label} must be on or off.`;
      continue;
    }
    if (field.input === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fieldErrors[field.key] = `${field.label} must be a number.`;
        continue;
      }
      if (field.min !== null && field.min !== undefined && value < field.min) {
        fieldErrors[field.key] = `${field.label} must be at least ${field.min}.`;
        continue;
      }
      if (field.max !== null && field.max !== undefined && value > field.max) {
        fieldErrors[field.key] = `${field.label} must be at most ${field.max}.`;
        continue;
      }
    }
    if (field.input === "select" && field.options?.length && !allowedOptionValue(field, value)) {
      fieldErrors[field.key] = `${field.label} must be one of the listed options.`;
    }
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    formError: null,
  };
}

