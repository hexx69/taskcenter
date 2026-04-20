import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MemoryBinding,
  MemoryListRecordsQuery,
  MemoryProviderDescriptor,
  MemoryRecord,
} from "@paperclipai/shared";
import { MEMORY_RETENTION_STATES, MEMORY_SCOPE_TYPES, MEMORY_SENSITIVITY_LABELS } from "@paperclipai/shared";
import { memoryApi } from "../api/memory";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { getSuggestedMemoryConfig, prettyMemoryConfig, validateMemoryProviderConfig } from "../lib/memory-config-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MemoryProviderConfigForm } from "./MemoryProviderConfigForm";

const DEFAULT_LOCAL_BASIC_CONFIG = {
  enablePreRunHydrate: true,
  enablePostRunCapture: true,
  enableIssueCommentCapture: false,
  enableIssueDocumentCapture: true,
  maxHydrateSnippets: 5,
};

function describeBindingConfig(binding: MemoryBinding) {
  if (binding.providerKey !== "local_basic") {
    const keys = Object.keys(binding.config ?? {});
    return keys.length > 0 ? `${keys.length} config field${keys.length === 1 ? "" : "s"}` : "Default config";
  }

  const config = { ...DEFAULT_LOCAL_BASIC_CONFIG, ...binding.config };
  return [
    config.enablePreRunHydrate ? "pre-run hydrate on" : "pre-run hydrate off",
    config.enablePostRunCapture ? "post-run capture on" : "post-run capture off",
    config.enableIssueDocumentCapture ? "issue docs on" : "issue docs off",
    config.enableIssueCommentCapture ? "comments on" : "comments off",
    `top ${String(config.maxHydrateSnippets)} snippets`,
  ].join(" • ");
}

function providerLabel(provider: MemoryProviderDescriptor | undefined, binding: MemoryBinding) {
  return provider?.displayName ?? binding.providerKey;
}

function providerDescription(provider: MemoryProviderDescriptor | undefined) {
  return provider?.description ?? "Memory provider";
}

function summarizeRecord(record: MemoryRecord) {
  const text = (record.summary ?? record.content).replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function recordScopeLabel(record: MemoryRecord) {
  return `${record.scopeType}${record.scopeId ? `:${record.scopeId.slice(0, 8)}` : ""}`;
}

function MemoryBindingCard({
  binding,
  isDefault,
  overrideCount,
  provider,
  onSetDefault,
}: {
  binding: MemoryBinding;
  isDefault: boolean;
  overrideCount: number;
  provider?: MemoryProviderDescriptor;
  onSetDefault: (bindingId: string) => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(binding.name ?? "");
  const [enabled, setEnabled] = useState(binding.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>(binding.config ?? {});
  const [configValid, setConfigValid] = useState(true);

  useEffect(() => {
    setName(binding.name ?? "");
    setEnabled(binding.enabled);
    setConfig(binding.config ?? {});
    setConfigValid(true);
  }, [binding]);

  const dirty =
    name !== (binding.name ?? "")
    || enabled !== binding.enabled
    || prettyMemoryConfig(config) !== prettyMemoryConfig(binding.config ?? {});

  const updateBinding = useMutation({
    mutationFn: async () => {
      const validation = validateMemoryProviderConfig(provider, config);
      if (!validation.valid) throw new Error("Provider config has invalid fields");
      return memoryApi.updateBinding(binding.id, {
        name: name.trim() || null,
        enabled,
        config,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Memory binding updated",
        body: `${binding.key} saved successfully.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update memory binding",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  return (
    <div className="rounded-md border border-border px-4 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{binding.name ?? binding.key}</h3>
            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
              {providerLabel(provider, binding)}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                binding.enabled
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}
            >
              {binding.enabled ? "Enabled" : "Disabled"}
            </span>
            {isDefault && (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-700 dark:text-blue-300">
                Company default
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">Key: {binding.key}</div>
          <div className="text-xs text-muted-foreground">{providerDescription(provider)}</div>
          <div className="text-xs text-muted-foreground">{describeBindingConfig(binding)}</div>
          <div className="text-xs text-muted-foreground">
            {overrideCount > 0 ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}` : "No project or agent overrides"}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isDefault}
          onClick={() => onSetDefault(binding.id)}
        >
          {isDefault ? "Default" : "Set as default"}
        </Button>
      </div>

      <div className="mt-4 grid gap-3">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Display name</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional label"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled
          </label>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Provider config</div>
          <MemoryProviderConfigForm
            provider={provider}
            value={config}
            onChange={setConfig}
            onValidationChange={setConfigValid}
          />
          {updateBinding.isError ? (
            <p className="text-xs text-destructive">
              {updateBinding.error instanceof Error ? updateBinding.error.message : "Failed to update binding"}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || !configValid || updateBinding.isPending}
            onClick={() => updateBinding.mutate()}
          >
            {updateBinding.isPending ? "Saving..." : "Save binding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CompanyMemorySettings({ companyId }: { companyId: string }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("default-memory");
  const [name, setName] = useState("Default memory");
  const [providerKey, setProviderKey] = useState("local_basic");
  const [config, setConfig] = useState<Record<string, unknown>>(DEFAULT_LOCAL_BASIC_CONFIG);
  const [configValid, setConfigValid] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [makeDefault, setMakeDefault] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  const [recordScopeType, setRecordScopeType] = useState("");
  const [recordSensitivity, setRecordSensitivity] = useState("");
  const [recordRetentionState, setRecordRetentionState] = useState("");
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [revokeReasonById, setRevokeReasonById] = useState<Record<string, string>>({});
  const [correctionRecord, setCorrectionRecord] = useState<MemoryRecord | null>(null);
  const [correctionContent, setCorrectionContent] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");

  const providersQuery = useQuery({
    queryKey: queryKeys.memory.providers(companyId),
    queryFn: () => memoryApi.providers(companyId),
  });

  const bindingsQuery = useQuery({
    queryKey: queryKeys.memory.bindings(companyId),
    queryFn: () => memoryApi.listBindings(companyId),
  });

  const targetsQuery = useQuery({
    queryKey: queryKeys.memory.targets(companyId),
    queryFn: () => memoryApi.listTargets(companyId),
  });

  const recordsFilters: Partial<MemoryListRecordsQuery> = {
    includeDeleted: false,
    scopeType: recordScopeType || undefined,
    sensitivityLabel: recordSensitivity || undefined,
    retentionState: recordRetentionState || undefined,
    includeRevoked,
    includeExpired,
    includeSuperseded: false,
    limit: 25,
  } as Partial<MemoryListRecordsQuery>;

  const recordsQuery = useQuery({
    queryKey: queryKeys.memory.records(companyId, recordsFilters),
    queryFn: () => memoryApi.listRecords(companyId, recordsFilters),
  });

  const providersByKey = useMemo(
    () => new Map((providersQuery.data ?? []).map((provider) => [provider.key, provider])),
    [providersQuery.data],
  );
  const selectedProvider = providersByKey.get(providerKey);

  const defaultBindingId =
    targetsQuery.data?.find((target) => target.targetType === "company" && target.targetId === companyId)?.bindingId ?? null;

  const overrideCountByBindingId = useMemo(() => {
    const result = new Map<string, number>();
    for (const target of targetsQuery.data ?? []) {
      if (target.targetType !== "agent" && target.targetType !== "project") continue;
      result.set(target.bindingId, (result.get(target.bindingId) ?? 0) + 1);
    }
    return result;
  }, [targetsQuery.data]);

  useEffect(() => {
    if (!providersQuery.data?.length) return;
    if (providersQuery.data.some((provider) => provider.key === providerKey)) return;
    const nextProvider = providersQuery.data[0]!;
    setProviderKey(nextProvider.key);
    setConfig(getSuggestedMemoryConfig(nextProvider));
    setConfigValid(true);
  }, [providerKey, providersQuery.data]);

  const createBinding = useMutation({
    mutationFn: async () => {
      const validation = validateMemoryProviderConfig(selectedProvider, config);
      if (!validation.valid) throw new Error("Provider config has invalid fields");
      const created = await memoryApi.createBinding(companyId, {
        key: key.trim(),
        name: name.trim() || null,
        providerKey,
        config,
        enabled,
      });
      if (makeDefault) {
        await memoryApi.setCompanyDefault(companyId, created.id);
      }
      return created;
    },
    onSuccess: async () => {
      setCreateError(null);
      setKey("default-memory");
      setName("Default memory");
      setConfig(getSuggestedMemoryConfig(providersByKey.get("local_basic")) ?? DEFAULT_LOCAL_BASIC_CONFIG);
      setConfigValid(true);
      setEnabled(true);
      setMakeDefault(true);
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Memory binding created",
        body: "The new binding is ready for company and agent scopes.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create memory binding",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const setCompanyDefault = useMutation({
    mutationFn: (bindingId: string) => memoryApi.setCompanyDefault(companyId, bindingId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Company default updated",
        body: "New runs will resolve memory through the selected binding.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update company memory default",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const revokeRecord = useMutation({
    mutationFn: ({ recordId, reason }: { recordId: string; reason: string }) =>
      memoryApi.revoke(companyId, { selector: { recordIds: [recordId] }, reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Memory record revoked",
        body: "The record is now hidden from browse and prompt hydration by default.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to revoke memory record",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const correctRecord = useMutation({
    mutationFn: () => {
      if (!correctionRecord) throw new Error("No memory record selected");
      return memoryApi.correctRecord(companyId, correctionRecord.id, {
        content: correctionContent,
        reason: correctionReason,
      });
    },
    onSuccess: async () => {
      setCorrectionRecord(null);
      setCorrectionContent("");
      setCorrectionReason("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Memory record corrected",
        body: "The original record was superseded and the correction is now the active memory.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to correct memory record",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const sweepRetention = useMutation({
    mutationFn: () => memoryApi.sweepRetention(companyId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Retention sweep completed",
        body: `${result.expiredRecordIds.length} expired record${result.expiredRecordIds.length === 1 ? "" : "s"} marked.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to sweep memory retention",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const isLoading = providersQuery.isLoading || bindingsQuery.isLoading || targetsQuery.isLoading;
  const error = providersQuery.error ?? bindingsQuery.error ?? targetsQuery.error ?? null;

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Memory
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Company memory bindings</h2>
          <p className="text-sm text-muted-foreground">
            Bindings determine where agent memory is hydrated from and where run summaries, issue documents, and other captured context are written.
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading memory settings...</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : (
          <>
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Binding key</label>
                  <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="default-memory" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Display name</label>
                  <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Default memory" />
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Provider</label>
                  <select
                    value={providerKey}
                    onChange={(event) => {
                      const nextKey = event.target.value;
                      const nextProvider = providersByKey.get(nextKey);
                      setProviderKey(nextKey);
                      setConfig(getSuggestedMemoryConfig(nextProvider));
                      setConfigValid(true);
                      setCreateError(null);
                    }}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
                  >
                    {(providersQuery.data ?? []).map((provider) => (
                      <option key={provider.key} value={provider.key}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                  />
                  Enabled
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={makeDefault}
                    onChange={(event) => setMakeDefault(event.target.checked)}
                  />
                  Set as company default
                </label>
              </div>
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Provider config</div>
                <MemoryProviderConfigForm
                  provider={selectedProvider}
                  value={config}
                  onChange={(nextConfig) => {
                    setConfig(nextConfig);
                    setCreateError(null);
                  }}
                  onValidationChange={setConfigValid}
                />
                {createError && <p className="text-xs text-destructive">{createError}</p>}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  disabled={!key.trim() || !providerKey || !configValid || createBinding.isPending}
                  onClick={() => {
                    setCreateError(null);
                    createBinding.mutate();
                  }}
                >
                  {createBinding.isPending ? "Creating..." : "Create binding"}
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Existing bindings</h3>
                <div className="text-xs text-muted-foreground">
                  {defaultBindingId ? "A company default is configured." : "No company default yet."}
                </div>
              </div>
              {(bindingsQuery.data ?? []).length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  Create a binding to enable memory hydration and capture for this company.
                </div>
              ) : (
                <div className="space-y-3">
                  {(bindingsQuery.data ?? []).map((binding) => (
                    <MemoryBindingCard
                      key={binding.id}
                      binding={binding}
                      isDefault={binding.id === defaultBindingId}
                      overrideCount={overrideCountByBindingId.get(binding.id) ?? 0}
                      provider={providersByKey.get(binding.providerKey)}
                      onSetDefault={(bindingId) => setCompanyDefault.mutate(bindingId)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Governed records</h2>
            <p className="text-sm text-muted-foreground">
              Inspect memory by scope, sensitivity, and retention state. Revoked, expired, and superseded records stay auditable but are excluded from hydration by default.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={sweepRetention.isPending}
            onClick={() => sweepRetention.mutate()}
          >
            {sweepRetention.isPending ? "Sweeping..." : "Sweep retention"}
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Scope</label>
            <select
              value={recordScopeType}
              onChange={(event) => setRecordScopeType(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
            >
              <option value="">Any scope</option>
              {MEMORY_SCOPE_TYPES.map((scopeType) => (
                <option key={scopeType} value={scopeType}>
                  {scopeType}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Sensitivity</label>
            <select
              value={recordSensitivity}
              onChange={(event) => setRecordSensitivity(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
            >
              <option value="">Any label</option>
              {MEMORY_SENSITIVITY_LABELS.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Retention</label>
            <select
              value={recordRetentionState}
              onChange={(event) => setRecordRetentionState(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
            >
              <option value="">Active records</option>
              {MEMORY_RETENTION_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(event) => setIncludeRevoked(event.target.checked)}
            />
            Include revoked
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeExpired}
              onChange={(event) => setIncludeExpired(event.target.checked)}
            />
            Include expired
          </label>
        </div>

        {recordsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading governed records...</p>
        ) : recordsQuery.error ? (
          <p className="text-sm text-destructive">{recordsQuery.error.message}</p>
        ) : (recordsQuery.data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No memory records match the current filters.
          </div>
        ) : (
          <div className="space-y-3">
            {(recordsQuery.data ?? []).map((record) => {
              const revokeReason = revokeReasonById[record.id] ?? "";
              const canMutate = record.retentionState === "active" && !record.revokedAt && !record.supersededByRecordId;
              return (
                <div key={record.id} className="rounded-md border border-border px-4 py-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm font-medium">{record.title ?? record.source?.kind ?? "Memory record"}</div>
                      <div className="text-xs text-muted-foreground">
                        {recordScopeLabel(record)} • {record.sensitivityLabel} • {record.retentionState}
                        {record.expiresAt ? ` • expires ${new Date(record.expiresAt).toLocaleDateString()}` : ""}
                      </div>
                      {record.citation?.label || record.citation?.sourceTitle ? (
                        <div className="text-xs text-muted-foreground">
                          Citation: {record.citation.label ?? record.citation.sourceTitle}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canMutate}
                        onClick={() => {
                          setCorrectionRecord(record);
                          setCorrectionContent(record.content);
                          setCorrectionReason("");
                        }}
                      >
                        Correct
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-foreground/90">{summarizeRecord(record)}</p>
                  {canMutate ? (
                    <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto] md:items-center">
                      <Input
                        value={revokeReason}
                        onChange={(event) =>
                          setRevokeReasonById((current) => ({ ...current, [record.id]: event.target.value }))
                        }
                        placeholder="Reason required to revoke"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!revokeReason.trim() || revokeRecord.isPending}
                        onClick={() => revokeRecord.mutate({ recordId: record.id, reason: revokeReason.trim() })}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {correctionRecord ? (
          <div className="space-y-3 rounded-md border border-border bg-accent/20 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Correct memory record</h3>
                <p className="text-xs text-muted-foreground">
                  This creates a superseding record and keeps the original for audit history.
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setCorrectionRecord(null)}>
                Cancel
              </Button>
            </div>
            <Textarea
              value={correctionContent}
              onChange={(event) => setCorrectionContent(event.target.value)}
              className="min-h-32"
            />
            <Input
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
              placeholder="Correction reason"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!correctionContent.trim() || !correctionReason.trim() || correctRecord.isPending}
                onClick={() => correctRecord.mutate()}
              >
                {correctRecord.isPending ? "Saving correction..." : "Save correction"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
