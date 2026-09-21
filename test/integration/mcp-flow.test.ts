import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The whole documented flow, driven through the real MCP protocol against a disposable IPT.
const URL = process.env["IPT_TEST_URL"];
const skip = URL ? false : "IPT_TEST_URL not set";
const FIXTURE = new globalThis.URL("../fixtures/occurrences.txt", import.meta.url).pathname;
const BAD_FIXTURE = new globalThis.URL("../fixtures/broken.txt", import.meta.url).pathname;
const OCC = "http://rs.tdwg.org/dwc/terms/Occurrence";
const sn = `mcp_${Date.now().toString(36)}`;

async function connect(extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    env: {
      ...process.env,
      IPT_URL: URL!,
      IPT_EMAIL: process.env["IPT_TEST_EMAIL"] ?? "admin@example.org",
      IPT_PASSWORD: process.env["IPT_TEST_PASSWORD"] ?? "Passw0rd-test",
      ...extraEnv,
    } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name, arguments: args });
    const body = res.content[0].text as string;
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    return { isError: !!res.isError, body, json };
  };
  return { client, call };
}

test("MCP: create → metadata → source → mapping → validate → publish", { skip, timeout: 300_000 }, async (t) => {
  const { client, call } = await connect();
  try {
    await t.test("create", async () => {
      const r = await call("ipt_create_resource", { shortname: sn, type: "occurrence" });
      assert.equal(r.isError, false, r.body);
    });

    await t.test("pre-flight lists what is missing", async () => {
      const r = await call("ipt_validate_resource", { shortname: sn });
      assert.equal(r.json.ready, false);
      assert.ok(r.json.problems.some((p: string) => /Basic Metadata/.test(p)));
      assert.ok(r.json.problems.some((p: string) => /no data sources/.test(p)));
    });

    await t.test("publish asks for confirmation and explains why it is not ready", async () => {
      const r = await call("ipt_publish", { shortname: sn });
      assert.equal(r.isError, true);
      assert.equal(r.json.needsConfirmation, true);
      assert.match(r.json.message, /NOT ready/);
      const forced = await call("ipt_publish", { shortname: sn, confirm: true });
      assert.equal(forced.isError, true);
      assert.ok(forced.json.problems.length > 0);
    });

    await t.test("metadata tools", async () => {
      const ada = { firstName: "Ada", lastName: "Lovelace", organisation: "Test Org", email: "ada@example.org" };
      assert.equal((await call("ipt_set_basic_metadata", { shortname: sn, title: "MCP flow dataset", description: "Dataset created through the MCP protocol by the integration test-suite, with a few invented records.", license: "ccby", language: "eng" })).isError, false);
      const bad = await call("ipt_set_contacts", { shortname: sn, contacts: [ada] });
      assert.equal(bad.isError, true);
      assert.equal((await call("ipt_set_contacts", { shortname: sn, contacts: [ada], creators: [ada], metadataProviders: [ada] })).isError, false);
      const cov = await call("ipt_set_coverage", {
        shortname: sn,
        geographic: [{ description: "Valencia", minLatitude: 38, maxLatitude: 40, minLongitude: -1, maxLongitude: 0.5 }],
        taxonomic: [{ taxa: [{ scientificName: "Quercus ilex", rank: "species" }] }],
        temporal: [{ startDate: "2019-01-01", endDate: "2023-12-31" }],
      });
      assert.equal(cov.isError, false, cov.body);
      const noSampling = await call("ipt_set_keywords_methods", { shortname: sn, methods: { studyExtent: "Valencia", steps: ["Field survey"] } });
      assert.equal(noSampling.isError, true);
      assert.match(noSampling.body, /Sampling Description is required/);
      const kw = await call("ipt_set_keywords_methods", { shortname: sn, keywords: [{ keywords: ["plants", "Spain"] }], methods: { studyExtent: "Valencia", sampleDescription: "Opportunistic sampling", steps: ["Field survey"] } });
      assert.equal(kw.isError, false, kw.body);
      const eml = (await call("ipt_get_draft_eml", { shortname: sn })).body;
      for (const tag of ["geographicCoverage", "taxonomicCoverage", "temporalCoverage", "keywordSet", "methodStep", "CC-BY"]) assert.ok(eml.includes(tag) || eml.toLowerCase().includes(tag.toLowerCase()), tag);
    });

    await t.test("a broken file is refused before upload; the good one is accepted", async () => {
      const bad = await call("ipt_add_source", { shortname: sn, type: "file", path: BAD_FIXTURE });
      assert.equal(bad.isError, true);
      assert.match(bad.body, /too_few_columns|too_many_columns/);
      const good = await call("ipt_add_source", { shortname: sn, type: "file", path: FIXTURE });
      assert.equal(good.isError, false, good.body);
      assert.equal(good.json.source, "occurrences");
      const st = await call("ipt_get_status", { shortname: sn });
      assert.deepEqual(st.json.sources.map((s: any) => [s.name, s.rows, s.columns]), [["occurrences", 5, 7]]);
    });

    await t.test("mapping", async () => {
      const ext = await call("ipt_list_extensions", { shortname: sn });
      assert.ok(ext.json.some((e: any) => e.rowType === OCC));
      const add = await call("ipt_add_mapping", { shortname: sn, rowType: OCC, source: "occurrences" });
      assert.equal(add.isError, false, add.body);
      assert.equal((await call("ipt_add_mapping", { shortname: sn, rowType: OCC, source: "occurrences" })).isError, true);
      assert.equal((await call("ipt_set_mapping", { shortname: sn, rowType: OCC, defaults: { "dwc:kingdom": "Plantae" } })).isError, false);
      const map = await call("ipt_get_mapping", { shortname: sn, rowType: OCC });
      assert.equal(map.json.idColumn, "occurrenceID");
      assert.ok(map.json.fields.some((f: any) => f.term === "dwc:scientificName" && f.column === "scientificName"));
      assert.ok(map.json.fields.some((f: any) => f.term === "dwc:kingdom" && f.default === "Plantae"));
      const peek = await call("ipt_peek_source", { shortname: sn, source: "occurrences" });
      assert.equal(peek.isError, false, peek.body);
    });

    await t.test("ready → publish waits and completes", async () => {
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.deepEqual(v.json.problems, []);
      assert.equal(v.json.ready, true);
      const p = await call("ipt_publish", { shortname: sn, summary: "via MCP", confirm: true });
      assert.equal(p.isError, false, p.body);
      assert.equal(p.json.state, "completed");
      assert.equal(p.json.version, "1.0");
      const status = await call("ipt_get_publication_status", { shortname: sn });
      assert.equal(status.json.state === "completed" || status.json.state === "unknown", true);
      assert.match(status.json.log ?? "", /5 records/);
      const st = await call("ipt_get_status", { shortname: sn });
      assert.equal(st.json.lastPublishedVersion, "1.0");
    });

    await t.test("visibility needs confirm and a new publication", async () => {
      assert.equal((await call("ipt_set_visibility", { shortname: sn, visibility: "public" })).json.needsConfirmation, true);
      assert.equal((await call("ipt_set_visibility", { shortname: sn, visibility: "public", confirm: true })).isError, false);
      const p = await call("ipt_publish", { shortname: sn, summary: "public", confirm: true });
      assert.equal(p.json.state, "completed");
      const list = await call("ipt_list_datasets", { query: sn });
      assert.equal(list.json.datasets[0].records, 5);
    });

    await t.test("delete needs confirm", async () => {
      assert.equal((await call("ipt_delete_resource", { shortname: sn })).json.needsConfirmation, true);
      assert.equal((await call("ipt_delete_resource", { shortname: sn, confirm: true })).isError, false);
      assert.equal((await call("ipt_get_status", { shortname: sn })).isError, true);
    });
  } finally {
    await client.close();
  }
});

test("MCP: read-only mode blocks every write tool", { skip, timeout: 60_000 }, async () => {
  const { client, call } = await connect({ IPT_READONLY: "1" });
  try {
    const r = await call("ipt_create_resource", { shortname: "should_not_exist", type: "occurrence" });
    assert.equal(r.isError, true);
    assert.match(r.body, /read-only/);
    assert.equal((await call("ipt_list_managed_resources", {})).isError, false);
  } finally {
    await client.close();
  }
});
