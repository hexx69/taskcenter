import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain("self.Worker = _undefined");
    expect(source).toContain("self.SharedWorker = _undefined");
    expect(source).toContain("self.Blob = _undefined");
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });
});
