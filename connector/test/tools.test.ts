import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { TOOL_NAMES } from "../src/tools.js";
import { errorText, IDS, startHarness, structured, type Harness } from "./helpers.js";

describe("v1 tool contracts", () => {
  let h: Harness;
  let a: Client; // member of company A only
  let b: Client; // member of company B only
  let nobody: Client; // valid token, no memberships

  before(async () => {
    h = await startHarness();
    a = await h.client(await h.token({ sub: "demo-user-a" }));
    b = await h.client(await h.token({ sub: "demo-user-b" }));
    nobody = await h.client(await h.token({ sub: "no-membership-user" }));
  });
  after(() => h.close());

  it("lists exactly the five read-only tools with input schemas and annotations", async () => {
    const { tools } = await a.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 20, `${t.name} needs a description`);
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
      assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
      assert.equal(t.annotations?.openWorldHint, false, `${t.name} openWorldHint`);
    }
  });

  describe("search_plugins", () => {
    it("returns only the caller's company plugins", async () => {
      const r = structured(await a.callTool({ name: "search_plugins", arguments: {} }));
      assert.equal(r.count, 2);
      assert.ok(r.plugins.every((p: any) => p.company_id === IDS.companyA));
    });

    it("filters by capability, availability and text", async () => {
      const byCap = structured(await a.callTool({ name: "search_plugins", arguments: { capability: "VERIFICATION" } }));
      assert.deepEqual(byCap.plugins.map((p: any) => p.id), [IDS.pluginA2]);
      const byAvail = structured(await a.callTool({ name: "search_plugins", arguments: { availability: "private_beta" } }));
      assert.deepEqual(byAvail.plugins.map((p: any) => p.id), [IDS.pluginA1]);
      const byText = structured(await a.callTool({ name: "search_plugins", arguments: { query: "intake" } }));
      assert.deepEqual(byText.plugins.map((p: any) => p.id), [IDS.pluginA1]);
    });

    it("returns nothing when filtering to a company the caller does not belong to", async () => {
      const r = structured(await a.callTool({ name: "search_plugins", arguments: { company: "isolation-co" } }));
      assert.equal(r.count, 0);
    });

    it("returns nothing for a user with no company memberships", async () => {
      const r = structured(await nobody.callTool({ name: "search_plugins", arguments: {} }));
      assert.equal(r.count, 0);
    });

    it("labels fixture data in meta", async () => {
      const r = structured(await a.callTool({ name: "search_plugins", arguments: {} }));
      assert.equal(r.meta.data_status, "fixture");
      assert.match(r.meta.notice, /not real/i);
      assert.ok(!Number.isNaN(Date.parse(r.meta.retrieved_at)));
    });

    it("rejects out-of-range limits and malformed company slugs", async () => {
      const big = await a.callTool({ name: "search_plugins", arguments: { limit: 500 } });
      assert.equal(big.isError, true);
      const bad = await a.callTool({ name: "search_plugins", arguments: { company: "Robert'); DROP TABLE" } });
      assert.equal(bad.isError, true);
    });
  });

  describe("get_plugin", () => {
    it("returns capabilities, permissions, dependencies and support", async () => {
      const { plugin } = structured(await a.callTool({ name: "get_plugin", arguments: { plugin_id: IDS.pluginA2 } }));
      assert.deepEqual(plugin.capabilities, ["verification", "release"]);
      assert.deepEqual(plugin.permissions, ["registry:read"]);
      assert.deepEqual(plugin.dependencies, [IDS.pluginA1]);
      assert.equal(plugin.support.owner, "Demo Owner");
    });

    it("treats another company's plugin exactly like a missing one", async () => {
      const cross = errorText(await a.callTool({ name: "get_plugin", arguments: { plugin_id: IDS.pluginB1 } }));
      const missing = errorText(
        await a.callTool({ name: "get_plugin", arguments: { plugin_id: "ffffffff-0000-4000-8000-000000000000" } }),
      );
      assert.equal(cross.replace(IDS.pluginB1, "X"), missing.replace("ffffffff-0000-4000-8000-000000000000", "X"));
    });

    it("lets company B read its own plugin", async () => {
      const { plugin } = structured(await b.callTool({ name: "get_plugin", arguments: { plugin_id: IDS.pluginB1 } }));
      assert.equal(plugin.company_id, IDS.companyB);
    });
  });

  describe("get_verification_report", () => {
    it("defaults to the current version and separates unresolved findings", async () => {
      const r = structured(await a.callTool({ name: "get_verification_report", arguments: { plugin_id: IDS.pluginA1 } }));
      assert.equal(r.report.version, "1.1.0");
      assert.equal(r.report.status, "conditional");
      assert.equal(r.report.evidence.length, 1);
      assert.equal(r.report.findings.length, 2);
      assert.deepEqual(r.unresolved_findings.map((f: any) => f.id), ["F-1"]);
    });

    it("errors when no report exists for the requested version", async () => {
      const t = errorText(
        await a.callTool({ name: "get_verification_report", arguments: { plugin_id: IDS.pluginA1, version: "9.9.9" } }),
      );
      assert.match(t, /No verification report/);
    });

    it("errors when the plugin has no current version and none is given", async () => {
      const t = errorText(await a.callTool({ name: "get_verification_report", arguments: { plugin_id: IDS.pluginA2 } }));
      assert.match(t, /no current version/);
    });

    it("does not return another company's report", async () => {
      const t = errorText(
        await a.callTool({ name: "get_verification_report", arguments: { plugin_id: IDS.pluginB1, version: "2.0.0" } }),
      );
      assert.match(t, /No plugin with id/);
    });
  });

  describe("list_releases", () => {
    it("lists the caller's releases newest first", async () => {
      const r = structured(await a.callTool({ name: "list_releases", arguments: {} }));
      assert.deepEqual(r.releases.map((x: any) => x.version), ["1.1.0", "1.0.0"]);
      assert.ok(r.releases.every((x: any) => x.company_id === IDS.companyA));
    });

    it("filters by status and plugin", async () => {
      const r = structured(
        await a.callTool({ name: "list_releases", arguments: { plugin_id: IDS.pluginA1, status: "released" } }),
      );
      assert.deepEqual(r.releases.map((x: any) => x.version), ["1.0.0"]);
    });

    it("returns nothing for another company's plugin", async () => {
      const r = structured(await a.callTool({ name: "list_releases", arguments: { plugin_id: IDS.pluginB1 } }));
      assert.equal(r.count, 0);
    });
  });

  describe("get_handoff", () => {
    it("returns an approved handoff", async () => {
      const { handoff } = structured(
        await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffApproved } }),
      );
      assert.equal(handoff.approval_status, "approved");
      assert.equal(handoff.approved_by, "Demo Owner");
    });

    it("does not return an unapproved handoff", async () => {
      const t = errorText(await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffDraft } }));
      assert.match(t, /No approved handoff/);
    });

    it("does not return another company's approved handoff", async () => {
      const t = errorText(await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffB } }));
      assert.match(t, /No approved handoff/);
    });
  });

  it("writes an audit log entry per tool call with subject and outcome, without record bodies", async () => {
    const before = h.logs.length;
    await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffApproved } });
    const entry = h.logs.slice(before).find((l) => l.event === "tool_call");
    assert.ok(entry);
    assert.equal(entry.fields.tool, "get_handoff");
    assert.equal(entry.fields.subject, "demo-user-a");
    assert.equal(entry.fields.outcome, "ok");
    assert.ok(!JSON.stringify(entry).includes("Demo content only"));
  });

  it("returns a generic error (no internals) when the store fails", async () => {
    const original = h.store.getPlugin.bind(h.store);
    h.store.getPlugin = async () => {
      throw new Error("connection refused at 10.0.0.5:5432");
    };
    try {
      const t = errorText(await a.callTool({ name: "get_plugin", arguments: { plugin_id: IDS.pluginA1 } }));
      assert.doesNotMatch(t, /10\.0\.0\.5/);
      assert.match(t, /could not complete/);
    } finally {
      h.store.getPlugin = original;
    }
  });
});
