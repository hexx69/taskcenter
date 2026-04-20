import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryBinding, MemoryProviderConfigFieldMetadata } from "@paperclipai/plugin-sdk";
import { buildQmdMemoryConfigMetadata, checkQmdMemoryHealth, createQmdMemoryProvider } from "../src/lib/provider.js";
import { resolveRecordPath } from "../src/lib/storage.js";

const fixedNow = new Date("2026-04-13T14:00:00.000Z");

function makeBinding(config: Record<string, unknown> = {}): MemoryBinding {
  return {
    id: "binding-1",
    companyId: "company-1",
    key: "default",
    name: "Default",
    providerKey: "qmd_memory",
    config,
    enabled: true,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

describe("createQmdMemoryProvider", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }));
    tempDirs.length = 0;
  });

  it("captures markdown records and refreshes the qmd index", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-qmd-memory-"));
    tempDirs.push(dataDir);
    const qmdClient = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
    };

    const provider = createQmdMemoryProvider({
      dataDir,
      qmdClient,
      now: () => fixedNow,
      createId: () => "record-1",
    });

    const result = await provider.capture({
      binding: makeBinding(),
      scope: {
        agentId: "agent-1",
        issueId: "issue-1",
      },
      source: {
        kind: "issue_comment",
        issueId: "issue-1",
        commentId: "comment-1",
      },
      title: "Important note",
      summary: "Short summary",
      content: "Long form memory body",
      metadata: {
        category: "decision",
      },
    });

    expect(result.records).toHaveLength(1);
    expect(qmdClient.refreshIndex).toHaveBeenCalledOnce();
    const recordPath = resolveRecordPath(dataDir, makeBinding(), "record-1");
    const raw = await readFile(recordPath, "utf8");
    expect(raw).toContain('recordId: "record-1"');
    expect(raw).toContain('title: "Important note"');
    expect(raw).toContain("Long form memory body");
  });

  it("queries qmd hits and filters by scope and metadata", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-qmd-memory-"));
    tempDirs.push(dataDir);
    const binding = makeBinding({ topK: 3 });
    const qmdClient = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
    };

    const provider = createQmdMemoryProvider({
      dataDir,
      qmdClient,
      now: () => fixedNow,
      createId: vi.fn()
        .mockReturnValueOnce("record-a")
        .mockReturnValueOnce("record-b")
        .mockReturnValueOnce("record-c"),
    });

    await provider.capture({
      binding,
      scope: { agentId: "agent-1", issueId: "issue-1" },
      source: { kind: "issue_comment", issueId: "issue-1", commentId: "comment-a" },
      title: "A",
      summary: "A",
      content: "Alpha memory",
      metadata: { category: "decision" },
    });
    await provider.capture({
      binding,
      scope: { agentId: "agent-2", issueId: "issue-2" },
      source: { kind: "issue_comment", issueId: "issue-2", commentId: "comment-b" },
      title: "B",
      summary: "B",
      content: "Beta memory",
      metadata: { category: "note" },
    });
    await provider.capture({
      binding,
      scope: { agentId: null, issueId: "issue-1" },
      source: { kind: "issue_document", issueId: "issue-1", documentKey: "spec" },
      title: "C",
      summary: "C",
      content: "Gamma memory",
      metadata: { category: "decision" },
    });

    qmdClient.query.mockResolvedValue([
      { recordId: "record-a" },
      { recordId: "record-b" },
      { recordId: "record-c" },
    ]);

    const result = await provider.query({
      binding,
      scope: { agentId: "agent-1", issueId: "issue-1" },
      query: "memory",
      topK: 5,
      metadataFilter: { category: "decision" },
    });

    expect(qmdClient.query).toHaveBeenCalledOnce();
    expect(result.records.map((record) => record.id)).toEqual(["record-a", "record-c"]);
  });

  it("forgets records by deleting files and reindexing", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-qmd-memory-"));
    tempDirs.push(dataDir);
    const binding = makeBinding();
    const qmdClient = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
    };

    const provider = createQmdMemoryProvider({
      dataDir,
      qmdClient,
      now: () => fixedNow,
      createId: () => "record-z",
    });

    await provider.capture({
      binding,
      scope: {},
      source: { kind: "run", runId: "run-1" },
      content: "To be removed",
      metadata: {},
    });

    if (!provider.forget) {
      throw new Error("Expected forget handler to be registered");
    }

    const result = await provider.forget({
      binding,
      scope: {},
      recordIds: ["record-z"],
    });

    expect(result.forgottenRecordIds).toEqual(["record-z"]);
    expect(qmdClient.refreshIndex).toHaveBeenCalledTimes(2);
    await expect(readFile(resolveRecordPath(dataDir, binding, "record-z"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("QMD memory provider config metadata", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }));
    tempDirs.length = 0;
  });

  it("suggests a storage root and field-level config metadata", () => {
    const metadata = buildQmdMemoryConfigMetadata("/tmp/paperclip-qmd");

    expect(metadata.pathSuggestions?.[0]).toMatchObject({
      key: "dataDir",
      path: "/tmp/paperclip-qmd",
    });
    expect(metadata.suggestedConfig).toMatchObject({
      searchMode: "query",
      topK: 5,
      autoIndexOnWrite: true,
      qmdBinaryPath: null,
    });
    expect(metadata.fields.map((field: MemoryProviderConfigFieldMetadata) => field.key)).toEqual([
      "searchMode",
      "topK",
      "autoIndexOnWrite",
      "qmdBinaryPath",
    ]);
  });

  it("reports storage and qmd binary health details", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-qmd-memory-health-"));
    tempDirs.push(dataDir);
    const health = await checkQmdMemoryHealth({
      dataDir,
      qmdClient: {
        refreshIndex: vi.fn(),
        query: vi.fn(),
        checkHealth: vi.fn().mockResolvedValue({
          available: false,
          binaryPath: "qmd",
          message: "qmd binary not found: qmd",
        }),
      },
    });

    expect(health.dataDir).toBe(dataDir);
    expect(health.checks).toEqual([
      expect.objectContaining({ key: "dataDir", status: "ok" }),
      expect.objectContaining({ key: "qmdBinary", status: "warning" }),
    ]);
  });
});
