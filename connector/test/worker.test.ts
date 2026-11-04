import assert from "node:assert/strict";
import { describe, it } from "node:test";
import dataset from "../fixtures/demo-registry.json" with { type: "json" };
import { withDemoMembers } from "../worker/index.js";
import type { RegistryDataset } from "../src/store/memory.js";

const data = dataset as unknown as RegistryDataset;

describe("worker demo memberships", () => {
  it("adds listed subjects to the demo company only", () => {
    const out = withDemoMembers(data, { DEMO_MEMBER_SUBJECTS: " user_a , user_b ," });
    const added = out.memberships.slice(data.memberships.length);
    assert.deepEqual(added.map((m) => m.user_subject), ["user_a", "user_b"]);
    assert.ok(added.every((m) => m.company_id === data.companies[0]!.id && m.role === "viewer"));
  });

  it("is a no-op when unset", () => {
    assert.equal(withDemoMembers(data, {}), data);
    assert.equal(withDemoMembers(data, { DEMO_MEMBER_SUBJECTS: "" }), data);
  });
});
