import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IptClient } from "../../src/ipt-client.ts";
import { IptManager } from "../../src/manager.ts";

const URL = process.env["IPT_TEST_URL"];
const skip = URL ? false : "IPT_TEST_URL not set";
const EMAIL = process.env["IPT_TEST_EMAIL"] ?? "admin@example.org";
const PASSWORD = process.env["IPT_TEST_PASSWORD"] ?? "Passw0rd-test";
const fx = (f: string) => new globalThis.URL(`../fixtures/${f}`, import.meta.url).pathname;
const OCC = "http://rs.tdwg.org/dwc/terms/Occurrence";
const TAXON = "http://rs.tdwg.org/dwc/terms/Taxon";
const uniq = (p: string) => `${p}_${Date.now().toString(36)}`;
const ada = { firstName: "Ada", lastName: "Lovelace", organisation: "Test Org" };

async function session() {
  const client = new IptClient(URL!);
  await client.login({ email: EMAIL, password: PASSWORD });
  return new IptManager(client);
}

async function completeMetadata(m: IptManager, sn: string, type: "occurrence" | "checklist" = "occurrence") {
  const a = await m.setBasicMetadata(sn, { title: `Extras ${sn}`, description: "Dataset created by the ipt-mcp integration tests with invented records used only for checking the publication workflow.", license: "cczero", coreType: type });
  assert.equal(a.ok, true, a.errors.join());
  const b = await m.setAgents(sn, { contacts: [ada], creators: [ada] });
  assert.equal(b.ok, true, b.errors.join());
}

test("checklist (Taxon core) publishes with 3 taxa", { skip, timeout: 240_000 }, async () => {
  const m = await session();
  const sn = uniq("chk");
  assert.equal((await m.createResource(sn, "checklist")).ok, true);
  try {
    await completeMetadata(m, sn, "checklist");
    assert.equal((await m.addSourceFile(sn, fx("taxa.txt"))).ok, true);
    const map = await m.addMapping(sn, TAXON, "taxa");
    assert.equal(map.ok, true, map.errors.join());
    const v = await m.validateResource(sn);
    assert.deepEqual(v.problems, []);
    const p = await m.publish(sn, "checklist");
    assert.equal(p.ok, true, p.errors.join());
    const rep = await m.waitForPublication(sn, 120_000, 1000, p.version);
    assert.equal(rep.state, "completed", rep.message);
    assert.match(await m.publicationLog(sn), /3 records/);
  } finally {
    await m.deleteResource(sn);
  }
});

test("URL source (served from this machine)", { skip, timeout: 240_000 }, async () => {
  const body = readFileSync(fx("occurrences.txt"));
  const server: Server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  const port = (server.address() as { port: number }).port;
  const m = await session();
  const sn = uniq("url");
  assert.equal((await m.createResource(sn, "occurrence")).ok, true);
  try {
    const host = process.env["IPT_TEST_HOST_FROM_IPT"] ?? "host.docker.internal";
    const add = await m.addSourceUrl(sn, `http://${host}:${port}/data.txt`, "remote");
    assert.equal(add.ok, true, add.errors.join());
    assert.equal(add.source, "remote");
    await m.configureSource(sn, "remote");
    const st = await m.getStatus(sn);
    assert.deepEqual(st.sources.map((s) => [s.name, s.rows, s.columns]), [["remote", 5, 7]]);
    const bad = await m.addSourceUrl(sn, `http://${host}:${port}/data.txt`.replace("http://", "notaurl:"), "broken");
    assert.equal(bad.ok, false);
  } finally {
    server.close();
    await m.deleteResource(sn);
  }
});

test("import an existing DwC-A, replace its EML, configure auto-publish", { skip, timeout: 240_000 }, async () => {
  const m = await session();
  const sn = uniq("imp");
  const imp = await m.createResource(sn, "occurrence", fx("sample-dwca.zip"));
  assert.equal(imp.ok, true, imp.errors.join());
  try {
    let st = await m.getStatus(sn);
    assert.equal(st.sources.length, 1);
    assert.equal(st.sources[0]?.rows, 5);
    assert.equal(st.mappings.length, 1);
    assert.deepEqual((await m.validateResource(sn)).problems, []);

    const dir = mkdtempSync(join(tmpdir(), "iptmcp-"));
    const eml = (await m.getDraftEml(sn)).replace(/<title[^>]*>[^<]*<\/title>/, "<title>Imported and renamed</title>");
    writeFileSync(join(dir, "eml.xml"), eml);
    assert.equal((await m.replaceEml(sn, join(dir, "eml.xml"))).ok, true);
    assert.match(await m.getDraftEml(sn), /Imported and renamed/);
    writeFileSync(join(dir, "junk.xml"), "this is not EML");
    const bad = await m.replaceEml(sn, join(dir, "junk.xml"));
    assert.equal(bad.ok, false);

    assert.equal((await m.setSettings(sn, "auto-publish", { updateFrequency: "weekly", updateFrequencyDayOfWeek: "friday" })).ok, true);
    const f = await m.getSettings(sn, "auto-publish");
    assert.equal(f.find((x) => x.name === "updateFrequency")?.value, "weekly");
    assert.equal((await m.setSettings(sn, "auto-publish", { nonsense: "1" })).ok, false);

    st = await m.getStatus(sn);
    assert.equal(st.shortname, sn);
  } finally {
    await m.deleteResource(sn);
  }
});

test("session expiry is transparent (re-login)", { skip, timeout: 120_000 }, async () => {
  const client = new IptClient(URL!);
  await client.login({ email: EMAIL, password: PASSWORD });
  const m = new IptManager(client);
  const sn = uniq("ses");
  assert.equal((await m.createResource(sn, "occurrence")).ok, true);
  try {
    await client.getHtml("/logout.do"); // server-side session ends
    const st = await m.getStatus(sn); // must log in again by itself
    assert.equal(st.shortname, sn);
  } finally {
    await m.deleteResource(sn);
  }
});

test("wrong credentials and unknown resources fail clearly", { skip, timeout: 60_000 }, async () => {
  const c = new IptClient(URL!);
  await assert.rejects(() => c.login({ email: EMAIL, password: "definitely-wrong" }), /wrong email\/password/);
  const m = await session();
  await assert.rejects(() => m.getStatus("does_not_exist_xyz"), /not found|not manageable|HTTP/);
});
