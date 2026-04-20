import { useEffect, useMemo, useState } from "react";
import type { MemoryProviderConfigFieldMetadata, MemoryProviderDescriptor } from "@paperclipai/shared";
import { ChevronDown, Database, FileSearch } from "lucide-react";
import {
  getMemoryConfigFields,
  parseMemoryConfigJson,
  prettyMemoryConfig,
  validateMemoryProviderConfig,
} from "../lib/memory-config-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

function fieldValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function coerceNumber(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function coerceSelectValue(field: MemoryProviderConfigFieldMetadata, value: string) {
  const option = (field.options ?? []).find((entry) => String(entry.value) === value);
  return option ? option.value : value;
}

function fieldGridClass(fields: MemoryProviderConfigFieldMetadata[]) {
  return fields.some((field) => field.input === "boolean")
    ? "grid gap-3 lg:grid-cols-2"
    : "grid gap-3 md:grid-cols-2";
}

export function MemoryProviderConfigForm({
  provider,
  value,
  onChange,
  onValidationChange,
}: {
  provider?: MemoryProviderDescriptor;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onValidationChange?: (valid: boolean) => void;
}) {
  const fields = useMemo(() => getMemoryConfigFields(provider), [provider]);
  const validation = useMemo(() => validateMemoryProviderConfig(provider, value), [provider, value]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonText, setJsonText] = useState(() => prettyMemoryConfig(value));
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    setJsonText(prettyMemoryConfig(value));
    setJsonError(null);
  }, [value]);

  useEffect(() => {
    onValidationChange?.(validation.valid && !jsonError);
  }, [jsonError, onValidationChange, validation.valid]);

  function updateField(key: string, nextValue: unknown) {
    onChange({ ...value, [key]: nextValue });
  }

  function renderField(field: MemoryProviderConfigFieldMetadata) {
    const error = validation.fieldErrors[field.key];
    const common = (
      <>
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
          {field.suggestedValue !== undefined && value[field.key] !== field.suggestedValue ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => updateField(field.key, field.suggestedValue)}
            >
              Use suggested
            </Button>
          ) : null}
        </div>
        {field.description ? <p className="text-xs text-muted-foreground">{field.description}</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </>
    );

    if (field.input === "boolean") {
      return (
        <div key={field.key} className="rounded-md border border-border px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">{common}</div>
            <ToggleSwitch
              checked={Boolean(value[field.key])}
              onCheckedChange={(checked) => updateField(field.key, checked)}
            />
          </div>
        </div>
      );
    }

    if (field.input === "select") {
      return (
        <div key={field.key} className="space-y-1">
          {common}
          <select
            value={fieldValue(value[field.key])}
            onChange={(event) => updateField(field.key, coerceSelectValue(field, event.target.value))}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
          >
            {(field.options ?? []).map((option) => (
              <option key={String(option.value)} value={fieldValue(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    return (
      <div key={field.key} className="space-y-1">
        {common}
        <Input
          type={field.input === "number" ? "number" : field.input === "secret" ? "password" : "text"}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          value={fieldValue(value[field.key])}
          placeholder={field.placeholder ?? undefined}
          onChange={(event) => {
            const raw = event.target.value;
            if (field.input === "number") {
              updateField(field.key, coerceNumber(raw));
            } else {
              updateField(field.key, raw.trim() === "" && field.defaultValue === null ? null : raw);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {fields.length > 0 ? (
        <div className={fieldGridClass(fields)}>{fields.map((field) => renderField(field))}</div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
          This provider does not publish schema fields yet. Use advanced JSON for its config.
        </div>
      )}

      {provider?.configMetadata?.pathSuggestions?.length ? (
        <div className="grid gap-2 md:grid-cols-2">
          {provider.configMetadata.pathSuggestions.map((suggestion) => (
            <div key={suggestion.key} className="rounded-md border border-border px-3 py-3 text-xs">
              <div className="flex items-center gap-2 font-medium">
                <FileSearch className="h-3.5 w-3.5 text-muted-foreground" />
                {suggestion.label}
              </div>
              <div className="mt-1 font-mono text-muted-foreground">{suggestion.path}</div>
              {suggestion.description ? <div className="mt-1 text-muted-foreground">{suggestion.description}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {provider?.configMetadata?.healthChecks?.length ? (
        <div className="grid gap-2 md:grid-cols-2">
          {provider.configMetadata.healthChecks.map((check) => (
            <div key={check.key} className="rounded-md border border-border px-3 py-3 text-xs">
              <div className="flex items-center gap-2 font-medium">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                {check.label}
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] uppercase",
                  check.status === "ok"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : check.status === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-accent text-muted-foreground",
                )}>
                  {check.status}
                </span>
              </div>
              {check.message ? <div className="mt-1 text-muted-foreground">{check.message}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-md border border-border">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !advancedOpen && "-rotate-90")} />
          Advanced JSON
        </button>
        {advancedOpen ? (
          <div className="space-y-2 border-t border-border px-3 py-3">
            <Textarea
              value={jsonText}
              onChange={(event) => {
                const nextText = event.target.value;
                setJsonText(nextText);
                try {
                  onChange(parseMemoryConfigJson(nextText));
                  setJsonError(null);
                } catch (error) {
                  setJsonError(error instanceof Error ? error.message : "Config must be valid JSON");
                }
              }}
              className="min-h-40 font-mono text-xs"
            />
            {jsonError ? <p className="text-xs text-destructive">{jsonError}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

