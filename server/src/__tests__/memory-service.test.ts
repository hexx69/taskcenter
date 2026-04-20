import { describe, expect, it, vi } from "vitest";
import { memoryService } from "../services/memory.js";

function createQueuedSelectDb(selectResults: unknown[][]) {
  const calls: Array<{ kind: string }> = [];
  const makeThenable = () => ({
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((resolve: (rows: unknown[]) => unknown) => {
      calls.push({ kind: "select" });
      return Promise.resolve(resolve(selectResults.shift() ?? []));
    }),
  });

  return {
    calls,
    db: {
      select: vi.fn(() => makeThenable()),
    } as any,
  };
}

function makeBinding(id: string, key: string, providerKey = "local_basic") {
  const now = new Date("2026-04-01T00:00:00.000Z");
  return {
    id,
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    key,
    name: key,
    providerKey,
    config: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("memoryService.forget", () => {
  it("rejects record sets that span multiple bindings", async () => {
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        bindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    ];

    const where = vi.fn().mockResolvedValue(rows);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
      update: vi.fn(),
    } as any;

    await expect(
      memoryService(db).forget(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        {
          recordIds: rows.map((row) => row.id),
          scope: {},
        },
        {
          actorType: "user",
          actorId: "board-user",
          agentId: null,
          userId: "board-user",
          runId: null,
        },
      ),
    ).rejects.toThrow("Memory records must belong to the same binding");

    expect(where).toHaveBeenCalledOnce();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("memoryService providers", () => {
  it("exposes config metadata with field-level defaults for built-in providers", async () => {
    const providers = await memoryService({} as any).providers();
    const local = providers.find((provider) => provider.key === "local_basic");

    expect(local?.configMetadata?.suggestedConfig).toMatchObject({
      enablePreRunHydrate: true,
      enablePostRunCapture: true,
      maxHydrateSnippets: 5,
    });
    expect(local?.configMetadata?.fields.map((field) => field.key)).toContain("maxHydrateSnippets");
    expect(local?.configMetadata?.healthChecks?.[0]).toMatchObject({
      key: "postgres",
      status: "ok",
    });
  });
});

describe("memoryService.resolveBinding", () => {
  it("prefers an agent override before project and company bindings", async () => {
    const agentBinding = makeBinding("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "agent");
    const { db } = createQueuedSelectDb([
      [{ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [{ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [
        {
          target: {
            id: "target-agent",
            companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            bindingId: agentBinding.id,
            targetType: "agent",
            targetId: "11111111-1111-4111-8111-111111111111",
            createdAt: agentBinding.createdAt,
            updatedAt: agentBinding.updatedAt,
          },
          binding: agentBinding,
        },
      ],
    ]);

    const resolved = await memoryService(db).resolveBinding(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {
        agentId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
      },
    );

    expect(resolved.source).toBe("agent_override");
    expect(resolved.checkedTargetTypes).toEqual(["agent"]);
    expect(resolved.binding?.id).toBe(agentBinding.id);
  });

  it("falls back from project override to company default", async () => {
    const companyBinding = makeBinding("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "company");
    const { db } = createQueuedSelectDb([
      [{ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [],
      [
        {
          target: {
            id: "target-company",
            companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            bindingId: companyBinding.id,
            targetType: "company",
            targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            createdAt: companyBinding.createdAt,
            updatedAt: companyBinding.updatedAt,
          },
          binding: companyBinding,
        },
      ],
    ]);

    const resolved = await memoryService(db).resolveBinding(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { projectId: "22222222-2222-4222-8222-222222222222" },
    );

    expect(resolved.source).toBe("company_default");
    expect(resolved.checkedTargetTypes).toEqual(["project", "company"]);
    expect(resolved.binding?.id).toBe(companyBinding.id);
  });

  it("rejects project scopes outside the company before resolving defaults", async () => {
    const { db } = createQueuedSelectDb([
      [{ companyId: "99999999-9999-4999-8999-999999999999" }],
    ]);

    await expect(
      memoryService(db).resolveBinding(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { projectId: "22222222-2222-4222-8222-222222222222" },
      ),
    ).rejects.toThrow("Memory scope project does not belong to company");
  });
});
