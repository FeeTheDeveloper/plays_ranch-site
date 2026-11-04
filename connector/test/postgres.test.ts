/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (superuser/owner on a
 * disposable database). Applies the migration, loads the demo fixture, then exercises
 * the store as the read-only plays_ranch_connector role. Skipped otherwise.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { loadDataset } from "../src/store/memory.js";
import { escapeLike, PostgresRegistryStore } from "../src/store/postgres.js";
import { FIXTURE, IDS, startHarness, structured, errorText, type Harness } from "./helpers.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const CONNECTOR_PASSWORD = "local-test-only";

async function seed(admin: pg.Client): Promise<void> {
  const sql = await readFile(new URL("../db/migrations/0001_registry.sql", import.meta.url), "utf8");
  await admin.query("drop schema if exists registry cascade");
  await admin.query(sql);
  await admin.query(`alter role plays_ranch_connector with login password '${CONNECTOR_PASSWORD}'`);
  const d = await loadDataset(FIXTURE);
  for (const c of d.companies) {
    await admin.query("insert into registry.companies (id, slug, name) values ($1,$2,$3)", [c.id, c.slug, c.name]);
  }
  for (const m of d.memberships) {
    await admin.query("insert into registry.company_memberships values ($1,$2,$3)", [m.user_subject, m.company_id, m.role]);
  }
  for (const p of d.plugins) {
    await admin.query(
      `insert into registry.plugins (id, company_id, slug, name, summary, capabilities, availability, current_version,
         permissions, dependencies, support_owner, support_channel, support_docs_url, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [p.id, p.company_id, p.slug, p.name, p.summary, p.capabilities, p.availability, p.current_version,
        p.permissions, p.dependencies, p.support.owner, p.support.channel, p.support.docs_url, p.updated_at],
    );
  }
  for (const r of d.verification_reports) {
    await admin.query(
      `insert into registry.verification_reports (id, company_id, plugin_id, version, status, verified_at, verifier, evidence, findings)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, r.company_id, r.plugin_id, r.version, r.status, r.verified_at, r.verifier,
        JSON.stringify(r.evidence), JSON.stringify(r.findings)],
    );
  }
  for (const r of d.releases) {
    await admin.query(
      `insert into registry.releases (id, company_id, plugin_id, version, channel, status, notes, approved_by, released_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, r.company_id, r.plugin_id, r.version, r.channel, r.status, r.notes, r.approved_by, r.released_at, r.created_at],
    );
  }
  for (const h of d.handoffs) {
    await admin.query(
      `insert into registry.handoffs (id, company_id, plugin_id, kind, title, status, approval_status, approved_by,
         approved_at, summary, body, source_uri, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [h.id, h.company_id, h.plugin_id, h.kind, h.title, h.status, h.approval_status, h.approved_by,
        h.approved_at, h.summary, h.body, h.source_uri, h.updated_at],
    );
  }
}

function connectorUrl(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = "plays_ranch_connector";
  u.password = CONNECTOR_PASSWORD;
  return u.toString();
}

describe("postgres registry store", { skip: !ADMIN_URL && "TEST_DATABASE_URL not set" }, () => {
  let admin: pg.Client;
  let store: PostgresRegistryStore;
  let h: Harness;

  before(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await seed(admin);
    store = new PostgresRegistryStore(connectorUrl(ADMIN_URL!), { ssl: false, max: 2 });
    h = await startHarness(store);
  });
  after(async () => {
    await h?.close();
    await store?.close();
    await admin?.end();
  });

  it("connects as the read-only role and cannot write", async () => {
    const conn = new pg.Client({ connectionString: connectorUrl(ADMIN_URL!) });
    await conn.connect();
    try {
      await assert.rejects(conn.query("update registry.plugins set name = 'x'"), /read-only|permission denied/);
    } finally {
      await conn.end();
    }
  });

  it("rejects a release whose plugin belongs to another company", async () => {
    await assert.rejects(
      admin.query(
        `insert into registry.releases (company_id, plugin_id, version, channel, status) values ($1,$2,'x','private','planned')`,
        [IDS.companyA, IDS.pluginB1],
      ),
      /does not belong to company/,
    );
  });

  it("resolves memberships", async () => {
    assert.deepEqual(await store.companyIdsForSubject("demo-user-a"), [IDS.companyA]);
    assert.deepEqual(await store.companyIdsForSubject("unknown"), []);
  });

  it("serves the same tool contracts with company isolation", async () => {
    const a = await h.client(await h.token({ sub: "demo-user-a" }));

    const search = structured(await a.callTool({ name: "search_plugins", arguments: {} }));
    assert.deepEqual(search.plugins.map((p: any) => p.id).sort(), [IDS.pluginA1, IDS.pluginA2]);
    assert.equal(search.meta.data_status, "live");

    const byCap = structured(await a.callTool({ name: "search_plugins", arguments: { capability: "Verification" } }));
    assert.deepEqual(byCap.plugins.map((p: any) => p.id), [IDS.pluginA2]);

    const { plugin } = structured(await a.callTool({ name: "get_plugin", arguments: { plugin_id: IDS.pluginA1 } }));
    assert.equal(plugin.support.owner, "Demo Owner");
    assert.equal(plugin.updated_at, "2026-10-30T00:00:00Z");

    errorText(await a.callTool({ name: "get_plugin", arguments: { plugin_id: IDS.pluginB1 } }));
    errorText(await a.callTool({ name: "get_plugin", arguments: { plugin_id: "not-a-uuid" } }));

    const vr = structured(await a.callTool({ name: "get_verification_report", arguments: { plugin_id: IDS.pluginA1 } }));
    assert.deepEqual(vr.unresolved_findings.map((f: any) => f.id), ["F-1"]);

    const rel = structured(await a.callTool({ name: "list_releases", arguments: {} }));
    assert.deepEqual(rel.releases.map((r: any) => r.version), ["1.1.0", "1.0.0"]);
    const relB = structured(await a.callTool({ name: "list_releases", arguments: { company: "isolation-co" } }));
    assert.equal(relB.count, 0);

    structured(await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffApproved } }));
    errorText(await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffDraft } }));
    errorText(await a.callTool({ name: "get_handoff", arguments: { handoff_id: IDS.handoffB } }));
  });

  it("matches LIKE wildcards literally", async () => {
    assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
    const a = await h.client(await h.token({ sub: "demo-user-a" }));
    const r = structured(await a.callTool({ name: "search_plugins", arguments: { query: "%" } }));
    assert.equal(r.count, 0);
  });
});
