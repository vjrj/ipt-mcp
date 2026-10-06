import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWriteStream, readFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { OCC, TAXON, addAndMap, archiveFile, cleanup, connect, fx, makePublic, newResource, publishAndWait, skip, tmp, until, write } from "./helpers.ts";

// README prompts 5 and 6: add the data (with validation) and map it to Darwin Core.

const HOST = process.env["IPT_TEST_HOST_FROM_IPT"] ?? "host.docker.internal";

test("prompt 5 — add the data, with validation", { skip, timeout: 400_000 }, async (t) => {
  const { client, call } = await connect();
  const sn = await newResource(call, "data");
  const dir = tmp();
  try {
    await t.test("'how many rows are broken and on which lines': validate_tsv reports counts and line numbers", async () => {
      const r = await call("validate_tsv", { path: fx("broken.txt") });
      assert.equal(r.isError, false);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.rows, 3);
      assert.deepEqual(
        r.json.issues.map((i: any) => [i.line, i.kind]),
        [[2, "too_many_columns"], [3, "out_of_range"], [4, "too_few_columns"]],
      );
      assert.equal(r.json.counts.too_many_columns, 1);
      assert.equal(r.json.counts.too_few_columns, 1);
      assert.equal(r.json.counts.out_of_range, 1);
      assert.ok(r.json.hints.length > 0);
      const clean = await call("validate_tsv", { path: fx("occurrences.txt") });
      assert.equal(clean.json.ok, true);
      assert.equal(clean.json.rows, 5);
    });

    await t.test("duplicate ids and bad encoding are caught before upload", async () => {
      const dup = await call("validate_tsv", { path: fx("duplicate_ids.txt") });
      assert.equal(dup.json.counts.duplicate_id, 1);
      const latin1 = write(dir, "latin1.txt", Buffer.from("occurrenceID\tscientificName\tlocality\nl1\tQuercus ilex\tCoruña\n", "latin1"));
      const enc = await call("validate_tsv", { path: latin1 });
      assert.equal(enc.json.invalidUtf8, true);
      const refused = await call("ipt_add_source", { shortname: sn, type: "file", path: latin1 });
      assert.equal(refused.isError, true);
      assert.match(refused.body, /refused|validation/);
      const st = await call("ipt_get_status", { shortname: sn });
      assert.equal(st.json.sources.length, 0, "nothing was uploaded");
    });

    await t.test("encoding: the IPT detects it on upload, and configure_source can override it (garbled → fixed)", async () => {
      const latin1 = write(dir, "latin1b.txt", Buffer.from("occurrenceID\tscientificName\tlocality\nl1\tQuercus ilex\tCoruña\nl2\tPinus\tMálaga\n", "latin1"));
      const add = await call("ipt_add_source", { shortname: sn, type: "file", path: latin1, skipValidation: true, name: "latin1b" });
      assert.equal(add.isError, false, add.body);
      const rows = async () => JSON.stringify((await call("ipt_peek_source", { shortname: sn, source: "latin1b" })).json.rows);
      assert.match(await rows(), /Coruña/, "detected on upload");
      assert.equal((await call("ipt_configure_source", { shortname: sn, source: "latin1b", encoding: "UTF-8" })).isError, false);
      assert.doesNotMatch(await rows(), /Coruña/, "read as UTF-8 the accents are garbled");
      assert.equal((await call("ipt_configure_source", { shortname: sn, source: "latin1b", encoding: "ISO-8859-1" })).isError, false);
      assert.match(await rows(), /Málaga/, "ISO-8859-1 restores them");
      await call("ipt_delete_source", { shortname: sn, source: "latin1b", confirm: true });
    });

    await t.test("header lines apply; a delimiter the IPT would ignore is reported instead of silently skipped", async () => {
      const add = await call("ipt_add_source", { shortname: sn, type: "file", path: fx("semicolon.csv"), delimiter: ";" });
      assert.equal(add.isError, false, add.body);
      const src = async () => (await call("ipt_get_status", { shortname: sn })).json.sources.find((s: any) => s.name === "semicolon");
      assert.deepEqual([(await src()).rows, (await src()).columns], [3, 3]);
      const peek = async () => (await call("ipt_peek_source", { shortname: sn, source: "semicolon" })).json;

      assert.deepEqual((await peek()).columns, ["occurrenceID", "scientificName", "eventDate"]);
      assert.equal((await peek()).rows.length, 3);
      assert.equal((await call("ipt_configure_source", { shortname: sn, source: "semicolon", headerLines: 0 })).isError, false);
      assert.deepEqual((await peek()).columns, ["Column #1", "Column #2", "Column #3"], "no header line: the columns are anonymous");
      assert.equal((await peek()).rows.length, 4, "and the header row is now data");
      assert.equal((await call("ipt_configure_source", { shortname: sn, source: "semicolon", headerLines: 1 })).isError, false);
      assert.equal((await peek()).rows.length, 3);

      const same = await call("ipt_configure_source", { shortname: sn, source: "semicolon", delimiter: ";" });
      assert.equal(same.isError, false, "the delimiter it already uses is fine");
      const other = await call("ipt_configure_source", { shortname: sn, source: "semicolon", delimiter: "," });
      assert.equal(other.isError, true);
      assert.match(other.body, /ignored the requested delimiter/);
      assert.match(other.body, /re-upload/);
      assert.equal((await src()).columns, 3, "and nothing changed");
      await call("ipt_delete_source", { shortname: sn, source: "semicolon", confirm: true });
    });

    await t.test("URL source: added, analysed and previewed; a 404 URL and a bad scheme are refused", async () => {
      const body = readFileSync(fx("occurrences.txt"));
      const server = createServer((req, res) => {
        if (req.url === "/data.txt") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(body);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(0, "0.0.0.0");
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      try {
        const add = await call("ipt_add_source", { shortname: sn, type: "url", url: `http://${HOST}:${port}/data.txt`, name: "remote" });
        assert.equal(add.isError, false, add.body);
        assert.equal(add.json.source, "remote");
        await call("ipt_configure_source", { shortname: sn, source: "remote" });
        const st = await call("ipt_get_status", { shortname: sn });
        const remote = st.json.sources.find((s: any) => s.name === "remote");
        assert.deepEqual([remote.rows, remote.columns], [5, 7]);
        // peek.do can briefly lag right after an analyse even though the row/column counts above are already
        // current (see DEVELOPMENT.md); on a slow CI runner it can take several seconds to catch up.
        const peek = await until(
          () => call("ipt_peek_source", { shortname: sn, source: "remote" }),
          (r) => r.json?.columns?.[0] === "occurrenceID",
          20,
          500,
        );
        assert.equal(peek.json.columns[0], "occurrenceID");
        assert.equal(peek.json.rows.length, 5, "reconfiguring a URL source must not lose its delimiter");
        assert.deepEqual(peek.json.rows[0].slice(0, 2), ["occ1", "Quercus ilex"]);
        const wired = await call("ipt_add_mapping", { shortname: sn, rowType: TAXON, source: "remote" });
        assert.equal(wired.isError, false, wired.body);
        assert.equal((await call("ipt_get_mapping", { shortname: sn, rowType: TAXON, mid: wired.json.mid })).json.columns.length, 7);
        await call("ipt_delete_mapping", { shortname: sn, rowType: TAXON, mid: wired.json.mid, confirm: true });

        const missing = await call("ipt_add_source", { shortname: sn, type: "url", url: `http://${HOST}:${port}/missing.txt`, name: "gone" });
        assert.equal(missing.isError, true);
        const scheme = await call("ipt_add_source", { shortname: sn, type: "url", url: "ftp://example.org/x.txt", name: "ftp" });
        assert.equal(scheme.isError, true);
        const noName = await call("ipt_add_source", { shortname: sn, type: "url", url: `http://${HOST}:${port}/data.txt` });
        assert.match(noName.body, /name/);
      } finally {
        server.close();
      }
    });

    await t.test("a large file (~25 MB, 250k rows) is validated in streaming, uploaded and counted", async () => {
      const big = join(dir, "big.txt");
      const ws = createWriteStream(big);
      ws.write("occurrenceID\tscientificName\teventDate\tdecimalLatitude\tdecimalLongitude\tbasisOfRecord\tlocality\n");
      const filler = "x".repeat(40);
      for (let i = 0; i < 250_000; i++) {
        if (!ws.write(`big${i}\tQuercus ilex\t2020-05-12\t39.47\t-0.37\tHumanObservation\tlocality ${filler}\n`)) await once(ws, "drain");
      }
      ws.end();
      await once(ws, "finish");
      const v = await call("validate_tsv", { path: big });
      assert.equal(v.json.ok, true, v.body.slice(0, 300));
      assert.equal(v.json.rows, 250_000);
      const add = await call("ipt_add_source", { shortname: sn, type: "file", path: big });
      assert.equal(add.isError, false, add.body);
      const st = await call("ipt_get_status", { shortname: sn });
      assert.equal(st.json.sources.find((s: any) => s.name === "big").rows, 250_000);
      await call("ipt_delete_source", { shortname: sn, source: "big", confirm: true });
    });

    await t.test("deleting a source needs confirmation and, once confirmed, removes it", async () => {
      await call("ipt_add_source", { shortname: sn, type: "file", path: fx("taxa.txt") });
      const names = async () => (await call("ipt_get_status", { shortname: sn })).json.sources.map((s: any) => s.name);
      assert.ok((await names()).includes("taxa"));
      const ask = await call("ipt_delete_source", { shortname: sn, source: "taxa" });
      assert.equal(ask.json.needsConfirmation, true);
      assert.ok((await names()).includes("taxa"), "still there without confirm");
      assert.equal((await call("ipt_delete_source", { shortname: sn, source: "taxa", confirm: true })).isError, false);
      assert.ok(!(await names()).includes("taxa"));
    });
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});

test("prompt 6 — map to Darwin Core", { skip, timeout: 300_000 }, async (t) => {
  const { client, call } = await connect();
  const sn = await newResource(call, "map");
  try {
    let mid = 0;
    await t.test("columns that automap cannot recognise are reported as unmapped, with the required terms still missing", async () => {
      const add = await call("ipt_add_source", { shortname: sn, type: "file", path: fx("custom_headers.txt") });
      assert.equal(add.isError, false, add.body);
      const map = await call("ipt_add_mapping", { shortname: sn, rowType: OCC, source: "custom_headers" });
      assert.equal(map.isError, false, map.body);
      assert.match(map.json.automap, /Automapped 1 columns/);
      mid = map.json.mid;
      const m = await call("ipt_get_mapping", { shortname: sn, rowType: OCC, mid });
      assert.deepEqual(m.json.columns, ["record_id", "sp", "obs_date", "lat", "lon", "country", "basis"]);
      assert.deepEqual(m.json.unmappedColumns, ["record_id", "sp", "obs_date", "lat", "lon", "basis"], "only 'country' was recognised");
      assert.ok(m.json.unmappedRequiredTerms.includes("dwc:basisOfRecord"));
      assert.equal(m.json.idColumn, undefined);
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.equal(v.json.ready, false);
      const problems = v.json.problems.join("\n");
      assert.match(problems, /no ID column selected/);
      assert.match(problems, /required term dwc:basisOfRecord is not mapped/);
    });

    await t.test("assign columns to terms, set fixed values and the ID column; the report follows", async () => {
      const set = await call("ipt_set_mapping", {
        shortname: sn, rowType: OCC, mid,
        idColumn: "record_id",
        columns: { eventDate: "obs_date", "dwc:scientificName": "sp", "http://rs.tdwg.org/dwc/terms/decimalLatitude": "lat", decimalLongitude: "lon", basisOfRecord: "basis" },
        defaults: { kingdom: "Plantae" },
      });
      assert.equal(set.isError, false, set.body);
      const m = await call("ipt_get_mapping", { shortname: sn, rowType: OCC, mid });
      assert.equal(m.json.idColumn, "record_id");
      const by = Object.fromEntries(m.json.fields.map((f: any) => [f.term, f]));
      assert.equal(by["dwc:eventDate"].column, "obs_date");
      assert.equal(by["dwc:scientificName"].column, "sp");
      assert.equal(by["dwc:decimalLatitude"].column, "lat");
      assert.equal(by["dwc:basisOfRecord"].column, "basis");
      assert.equal(by["dwc:kingdom"].default, "Plantae");
      assert.deepEqual(m.json.unmappedColumns, [], "every column is used now");
      assert.deepEqual(m.json.unmappedRequiredTerms, []);
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.deepEqual(v.json.problems, []);
    });

    await t.test("unmapping a term (null) puts its column back in the unmapped list and the term back in the missing ones", async () => {
      const r = await call("ipt_set_mapping", { shortname: sn, rowType: OCC, mid, columns: { basisOfRecord: null } });
      assert.equal(r.isError, false, r.body);
      const m = await call("ipt_get_mapping", { shortname: sn, rowType: OCC, mid });
      assert.deepEqual(m.json.unmappedColumns, ["basis"]);
      assert.ok(m.json.unmappedRequiredTerms.includes("dwc:basisOfRecord"));
      assert.equal((await call("ipt_validate_resource", { shortname: sn })).json.ready, false);
      // a fixed value (vocabulary term) also satisfies the requirement
      assert.equal((await call("ipt_set_mapping", { shortname: sn, rowType: OCC, mid, defaults: { basisOfRecord: "HumanObservation" } })).isError, false);
      const again = await call("ipt_get_mapping", { shortname: sn, rowType: OCC, mid });
      assert.deepEqual(again.json.unmappedRequiredTerms, []);
      assert.equal(again.json.fields.find((f: any) => f.term === "dwc:basisOfRecord").default, "HumanObservation");
      assert.equal((await call("ipt_validate_resource", { shortname: sn })).json.ready, true);
      // and back to the column
      await call("ipt_set_mapping", { shortname: sn, rowType: OCC, mid, columns: { basisOfRecord: "basis" }, defaults: { basisOfRecord: "" } });
    });

    await t.test("unknown terms and columns are refused with the valid options listed", async () => {
      const badTerm = await call("ipt_set_mapping", { shortname: sn, rowType: OCC, mid, defaults: { notATerm: "x" } });
      assert.equal(badTerm.isError, true);
      assert.match(badTerm.body, /unknown term "notATerm"/);
      const badCol = await call("ipt_set_mapping", { shortname: sn, rowType: OCC, mid, columns: { eventDate: "nope" } });
      assert.match(badCol.body, /unknown column "nope"; columns: record_id, sp/);
      const badId = await call("ipt_set_mapping", { shortname: sn, rowType: OCC, mid, idColumn: "nope" });
      assert.match(badId.body, /unknown column/);
    });

    await t.test("the mapping is what gets published: values from the renamed columns reach the DwC-A", async () => {
      await makePublic(call, sn);
      const occ = await archiveFile(sn, "occurrence.txt");
      const lines = occ.trim().split("\n");
      assert.equal(lines.length, 4, "header + 3 records");
      const header = lines[0]!.split("\t");
      const row = lines[1]!.split("\t");
      const cell = (term: string) => row[header.findIndex((h) => h.toLowerCase() === term.toLowerCase())];
      assert.equal(cell("eventDate"), "2020-05-12");
      assert.equal(cell("scientificName"), "Quercus ilex");
      assert.equal(cell("decimalLatitude"), "39.47");
      assert.equal(cell("country"), "ES", "the automapped column");
      assert.equal(cell("basisOfRecord"), "HumanObservation");
      assert.equal(cell("kingdom"), "Plantae");
    });

    await t.test("deleting a mapping needs confirmation; a second mapping of the same type is refused", async () => {
      const dup = await call("ipt_add_mapping", { shortname: sn, rowType: OCC, source: "custom_headers" });
      assert.equal(dup.isError, true);
      assert.match(dup.body, /already exists/);
      const forced = await call("ipt_add_mapping", { shortname: sn, rowType: OCC, source: "custom_headers", allowDuplicate: true });
      assert.equal(forced.isError, false, forced.body);
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.match(v.json.warnings.join("\n"), /more than one mapping/);

      const count = async () => (await call("ipt_get_status", { shortname: sn })).json.mappings.length;
      assert.equal(await count(), 2);
      const ask = await call("ipt_delete_mapping", { shortname: sn, rowType: OCC, mid: forced.json.mid });
      assert.equal(ask.json.needsConfirmation, true);
      assert.equal(await count(), 2, "still there without confirm");
      assert.equal((await call("ipt_delete_mapping", { shortname: sn, rowType: OCC, mid: forced.json.mid, confirm: true })).isError, false);
      assert.equal(await count(), 1);
    });
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});
