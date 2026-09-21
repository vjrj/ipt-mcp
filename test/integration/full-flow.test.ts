import { test } from "node:test";
import assert from "node:assert/strict";
import { IptClient } from "../../src/ipt-client.ts";
import { IptManager } from "../../src/manager.ts";

// Needs a disposable IPT (see harness/start-ipt.sh). Skipped when IPT_TEST_URL is not set.
const URL = process.env["IPT_TEST_URL"];
const skip = URL ? false : "IPT_TEST_URL not set";
const EMAIL = process.env["IPT_TEST_EMAIL"] ?? "admin@example.org";
const PASSWORD = process.env["IPT_TEST_PASSWORD"] ?? "Passw0rd-test";
const FIXTURE = new globalThis.URL("../fixtures/occurrences.txt", import.meta.url).pathname;
const OCC = "http://rs.tdwg.org/dwc/terms/Occurrence";
const sn = `it_${Date.now().toString(36)}`;

test("documented flow: create → metadata → source → mapping → publish → public", { skip, timeout: 240_000 }, async (t) => {
  const client = new IptClient(URL!);
  await client.login({ email: EMAIL, password: PASSWORD });
  const m = new IptManager(client);

  await t.test("create resource; duplicate shortname rejected", async () => {
    assert.equal((await m.createResource(sn, "occurrence")).ok, true);
    const dup = await m.createResource(sn, "occurrence");
    assert.equal(dup.ok, false);
  });

  await t.test("pre-flight refuses an incomplete resource (the IPT itself would publish it)", async () => {
    const r = await m.publish(sn);
    assert.equal(r.ok, false);
    const p = (r.problems ?? []).join("\n");
    assert.match(p, /metadata \/ Basic Metadata: .*[Tt]itle/);
    assert.match(p, /At least one contact/);
    assert.match(p, /no data sources/);
    assert.equal((await m.getStatus(sn)).lastPublishedVersion, undefined, "nothing was published");
  });

  await t.test("basic metadata: bad license key is a clear error, good one saves", async () => {
    await assert.rejects(() => m.setBasicMetadata(sn, { license: "nope" }), /unknown license key/);
    const r = await m.setBasicMetadata(sn, {
      title: "Integration test dataset",
      description: "Integration dataset created by the ipt-mcp test-suite with a handful of invented occurrence records for checking publication.",
      license: "cczero",
    });
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  await t.test("agents: missing creator is rejected; full set saves; replace shrinks the list", async () => {
    const ada = { firstName: "Ada", lastName: "Lovelace", organisation: "Test Org" };
    const bad = await m.setAgents(sn, { contacts: [ada] });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(" "), /creator/i);
    assert.equal((await m.setAgents(sn, { contacts: [ada, { ...ada, firstName: "Bea" }], creators: [ada], metadataProviders: [ada] })).ok, true);
    assert.equal((await m.setAgents(sn, { contacts: [ada] })).ok, true);
  });

  await t.test("source: upload, analyse, counts", async () => {
    const add = await m.addSourceFile(sn, FIXTURE);
    assert.equal(add.ok, true, add.errors.join());
    assert.equal(add.source, "occurrences");
    assert.equal((await m.configureSource(sn, "occurrences")).ok, true);
    const st = await m.getStatus(sn);
    assert.deepEqual(st.sources.map((s) => [s.name, s.rows, s.columns]), [["occurrences", 5, 7]]);
  });

  await t.test("mapping: automap on create, duplicate refused, term edit", async () => {
    const add = await m.addMapping(sn, OCC, "occurrences");
    assert.equal(add.ok, true, add.errors.join());
    assert.match(add.automap ?? "", /7 columns/);
    const dup = await m.addMapping(sn, OCC, "occurrences");
    assert.equal(dup.ok, false);
    assert.match(dup.errors.join(), /already exists/);

    const page = await m.getMapping(sn, OCC, add.mid ?? 0);
    assert.equal(page.idColumn, 0);
    const mapped = page.fields.filter((f) => f.index !== undefined).map((f) => f.qualName);
    assert.ok(mapped.includes("dwc:scientificName"), mapped.join());

    const set = await m.setMapping(sn, OCC, add.mid ?? 0, { defaults: { "dwc:kingdom": "Plantae" } });
    assert.equal(set.ok, true, set.errors.join());
    const again = await m.getMapping(sn, OCC, add.mid ?? 0);
    assert.equal(again.fields.find((f) => f.qualName === "dwc:kingdom")?.defaultValue, "Plantae");
    await assert.rejects(() => m.setMapping(sn, OCC, 0, { columns: { "dwc:kingdom": "nope" } }), /unknown column/);
    await assert.rejects(() => m.setMapping(sn, OCC, 0, { defaults: { "dwc:notATerm": "x" } }), /unknown term/);
  });

  await t.test("publish v1.0 and wait", async () => {
    const v = await m.validateResource(sn);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ready, true);
    const r = await m.publish(sn, "first");
    assert.equal(r.ok, true, r.errors.join());
    assert.equal(r.version, "1.0");
    const rep = await m.waitForPublication(sn, 120_000, 1000, r.version);
    assert.equal(rep.state, "completed", rep.message);
    const st = await m.getStatus(sn);
    assert.equal(st.lastPublishedVersion, "1.0");
  });

  await t.test("private resource is not in the public inventory; public one is, with the DwC-A", async () => {
    const pub = new IptClient(URL!);
    assert.equal((await pub.listDatasets()).some((d) => d.id === sn), false);
    assert.equal((await m.setVisibility(sn, "public")).ok, true);
    assert.equal((await m.getStatus(sn)).visibilityChangePending, true);
    // The change only takes effect with the next publication (v1.1).
    const again = await m.publish(sn, "make public");
    assert.equal(again.ok, true, again.errors.join());
    assert.equal((await m.waitForPublication(sn, 120_000, 1000, again.version)).state, "completed");
    const after = await m.getStatus(sn);
    assert.equal(after.lastPublishedVersion, "1.1");
    assert.equal(after.visibilityChangePending, false);
    const ds = (await pub.listDatasets()).find((d) => d.id === sn);
    assert.ok(ds, "dataset listed after making it public");
    assert.equal(ds.records, 5);
    const zip = await fetch(ds.archiveUrl!.replace(/^https?:\/\/[^/]+/, URL!.replace(/\/ipt$/, "")));
    const buf = Buffer.from(await zip.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), "PK");
    assert.ok(buf.includes("occurrence.txt") && buf.includes("meta.xml") && buf.includes("eml.xml"));
  });

  await t.test("delete resource", async () => {
    assert.equal((await m.deleteResource(sn)).ok, true);
    await assert.rejects(() => m.getStatus(sn));
  });
});
