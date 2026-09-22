import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OCC, addAndMap, archiveFile, cleanup, connect, fx, makePublic, newResource, publishAndWait, skip, tmp, uniq, write } from "./helpers.ts";

// README prompts 7 to 12: check, publish, make public, update a version, automatic publication, diagnosis and clean-up.

const datasetOf = async (call: any, sn: string) => (await call("ipt_list_datasets", {})).json.datasets.find((d: any) => d.id === sn);

test("prompts 7 and 8 — check before publishing, publish, metadata only", { skip, timeout: 400_000 }, async (t) => {
  const { client, call } = await connect();
  const made: string[] = [];
  try {
    await t.test("an incomplete resource is reported section by section and is not published", async () => {
      const sn = uniq("inc");
      made.push(sn);
      assert.equal((await call("ipt_create_resource", { shortname: sn, type: "occurrence" })).isError, false);
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.equal(v.json.ready, false);
      const text = v.json.problems.join("\n");
      assert.match(text, /basic/i, "the basic metadata section is named");
      assert.match(text, /no data source|no source|no mapping/i);

      const ask = await call("ipt_publish", { shortname: sn });
      assert.match(ask.body, /NOT ready/, "asking to publish without confirm explains why not");
      const forced = await call("ipt_publish", { shortname: sn, confirm: true });
      assert.equal(forced.isError, true);
      assert.match(forced.body, /not ready to publish/);
      const st = await call("ipt_get_status", { shortname: sn });
      assert.equal(st.json.lastPublishedVersion, undefined, "nothing was published");
    });

    await t.test("publish: asks first, then publishes and reports version, records and log", async () => {
      const sn = await newResource(call, "pub");
      made.push(sn);
      await addAndMap(call, sn, fx("occurrences.txt"));
      const v = await call("ipt_validate_resource", { shortname: sn });
      assert.deepEqual(v.json.problems, []);
      assert.equal(v.json.ready, true);

      const ask = await call("ipt_publish", { shortname: sn, summary: "First version" });
      assert.equal(ask.json.needsConfirmation, true);
      assert.match(ask.body, /version 1\.0/, "tells which version will be created");
      assert.equal((await call("ipt_get_status", { shortname: sn })).json.lastPublishedVersion, undefined, "asking does not publish");

      const p = await call("ipt_publish", { shortname: sn, summary: "First version", confirm: true });
      assert.equal(p.isError, false, p.body);
      assert.equal(p.json.state, "completed");
      assert.equal(p.json.version, "1.0");
      const st = (await call("ipt_get_status", { shortname: sn })).json;
      assert.equal(st.lastPublishedVersion, "1.0");
      assert.equal(st.nextVersion, "1.1");
      const pub = await call("ipt_get_publication_status", { shortname: sn });
      assert.equal(pub.json.state, "completed");
      assert.match(pub.json.log, /5 records/);
    });

    await t.test("wait:false returns at once and the status tool follows the publication to its end", async () => {
      const sn = made.at(-1)!;
      const p = await call("ipt_publish", { shortname: sn, summary: "Second", confirm: true, wait: false });
      assert.equal(p.isError, false, p.body);
      assert.equal(p.json.version, "1.1");
      let state = "";
      for (let i = 0; i < 40 && state !== "completed"; i++) {
        state = (await call("ipt_get_publication_status", { shortname: sn, logLines: 0 })).json.state;
        if (state !== "completed") await new Promise((r) => setTimeout(r, 1000));
      }
      assert.equal(state, "completed");
      assert.equal((await call("ipt_get_status", { shortname: sn })).json.lastPublishedVersion, "1.1");
    });

    await t.test("metadata only: blocked without the flag, published with it, and the archive carries no data", async () => {
      const sn = await newResource(call, "meta");
      made.push(sn);
      const strict = await call("ipt_validate_resource", { shortname: sn });
      assert.equal(strict.json.ready, false, "a resource without data is not ready by default");
      const lax = await call("ipt_validate_resource", { shortname: sn, metadataOnly: true });
      assert.equal(lax.json.ready, true, JSON.stringify(lax.json));
      assert.equal((await call("ipt_publish", { shortname: sn, confirm: true })).isError, true);
      const p = await call("ipt_publish", { shortname: sn, summary: "metadata only", metadataOnly: true, confirm: true });
      assert.equal(p.isError, false, p.body);
      assert.equal(p.json.state, "completed");
      assert.equal((await call("ipt_get_status", { shortname: sn })).json.lastPublishedVersion, "1.0");
    });
  } finally {
    await cleanup(call, ...made);
    await client.close();
  }
});

test("prompt 9 — make public, appears in the public list with its record count; and back to private", { skip, timeout: 400_000 }, async () => {
  const { client, call } = await connect();
  const sn = await newResource(call, "vis");
  try {
    await addAndMap(call, sn, fx("occurrences.txt"));
    assert.equal((await call("ipt_publish", { shortname: sn, confirm: true })).json.state, "completed");
    assert.equal((await call("ipt_get_status", { shortname: sn })).json.visibility, "private");
    assert.equal(await datasetOf(call, sn), undefined, "private resources are not listed");

    const ask = await call("ipt_set_visibility", { shortname: sn, visibility: "public" });
    assert.equal(ask.json.needsConfirmation, true);
    assert.equal((await call("ipt_get_status", { shortname: sn })).json.visibility, "private", "asking changes nothing");

    assert.equal((await call("ipt_set_visibility", { shortname: sn, visibility: "public", confirm: true })).isError, false);
    const pending = (await call("ipt_get_status", { shortname: sn })).json;
    assert.equal(pending.visibilityChangePending, true, "the change waits for the next publication");
    assert.equal(await datasetOf(call, sn), undefined);

    assert.equal((await publishAndWait(call, sn, "make public")).json.state, "completed");
    assert.equal((await call("ipt_get_status", { shortname: sn })).json.visibility, "public");
    const ds = await datasetOf(call, sn);
    assert.equal(ds.records, 5, "listed with its record count");
    assert.equal(ds.version, 1.1);

    // and back: private applies with the next publication, after which the resource leaves the public list
    assert.equal((await call("ipt_set_visibility", { shortname: sn, visibility: "private", confirm: true })).isError, false);
    assert.equal((await publishAndWait(call, sn, "make private")).json.state, "completed");
    assert.equal((await call("ipt_get_status", { shortname: sn })).json.visibility, "private");
    assert.equal(await datasetOf(call, sn), undefined, "gone from the public list again");

    // asking for the state it already has is reported, not silently accepted
    const again = await call("ipt_set_visibility", { shortname: sn, visibility: "private", confirm: true });
    assert.equal(again.isError, true);
    assert.match(again.body, /invalid change/i);
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});

test("prompt 10 — update a version: re-upload the same source, re-analyse, mapping still complete, next version", { skip, timeout: 400_000 }, async () => {
  const { client, call } = await connect();
  const sn = await newResource(call, "upd");
  try {
    await addAndMap(call, sn, fx("occurrences.txt"));
    await makePublic(call, sn);
    assert.equal((await datasetOf(call, sn)).records, 5);
    const before = (await call("ipt_get_status", { shortname: sn })).json;
    assert.equal(before.lastPublishedVersion, "1.0");

    // a file with duplicate ids is refused by the validation before it can replace the good source
    const dir = tmp();
    const bad = await call("ipt_add_source", { shortname: sn, type: "file", path: write(dir, "occurrences.txt", readFileSync(fx("duplicate_ids.txt"))) });
    assert.equal(bad.isError, true);
    assert.match(bad.body, /duplicate/i);
    assert.equal((await call("ipt_get_status", { shortname: sn })).json.sources[0].rows, 5, "the good source is untouched");

    // the changed file (7 records), same file name: the source of that name is replaced
    const again = await call("ipt_add_source", { shortname: sn, type: "file", path: write(dir, "occurrences.txt", readFileSync(fx("occurrences_v2.txt"))) });
    assert.equal(again.isError, false, again.body);
    assert.equal((await call("ipt_configure_source", { shortname: sn, source: "occurrences" })).isError, false);
    const st = (await call("ipt_get_status", { shortname: sn })).json;
    assert.equal(st.sources.length, 1, "replaced, not duplicated");
    assert.deepEqual([st.sources[0].rows, st.sources[0].columns], [7, 7]);
    assert.equal(st.mappings.length, 1);
    const m = await call("ipt_get_mapping", { shortname: sn, rowType: OCC, mid: st.mappings[0].mid });
    assert.deepEqual(m.json.unmappedRequiredTerms, []);
    assert.equal((await call("ipt_validate_resource", { shortname: sn })).json.ready, true);

    const p = await publishAndWait(call, sn, "seven records");
    assert.equal(p.json.state, "completed", p.body);
    assert.equal(p.json.version, "1.1");
    assert.equal((await datasetOf(call, sn)).records, 7);
    assert.equal((await archiveFile(sn, "occurrence.txt")).trim().split("\n").length, 8);
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});

test("prompt 11 — automatic publication: every Friday at 12:00", { skip, timeout: 200_000 }, async () => {
  const { client, call } = await connect();
  const sn = await newResource(call, "auto");
  try {
    const form = await call("ipt_get_settings", { shortname: sn, page: "auto-publish" });
    const names = form.json.map((f: any) => f.name);
    assert.ok(names.includes("updateFrequency"), names.join(","));
    const set = await call("ipt_set_settings", { shortname: sn, page: "auto-publish", values: { updateFrequency: "weekly", updateFrequencyDayOfWeek: "friday", updateFrequencyTime: "12:00" } });
    assert.equal(set.isError, false, set.body);
    const back = Object.fromEntries((await call("ipt_get_settings", { shortname: sn, page: "auto-publish" })).json.map((f: any) => [f.name, f.value]));
    assert.equal(back["updateFrequency"], "weekly");
    assert.match(String(back["updateFrequencyDayOfWeek"]), /friday|6/i);
    assert.match(String(back["updateFrequencyTime"]), /12:00|12/);
    const bad = await call("ipt_set_settings", { shortname: sn, page: "auto-publish", values: { nonsense: "1" } });
    assert.equal(bad.isError, true);
    assert.match(bad.body, /unknown field/);
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});

test("prompt 12 — a failed publication is diagnosed from its status and log; deleting a resource needs confirmation", { skip, timeout: 300_000 }, async (t) => {
  const { client, call } = await connect();
  const sn = await newResource(call, "fail");
  try {
    await t.test("duplicate record ids make the publication fail, and the tools say so", async () => {
      const add = await call("ipt_add_source", { shortname: sn, type: "file", path: fx("duplicate_ids.txt"), skipValidation: true });
      assert.equal(add.isError, false, add.body);
      const map = await call("ipt_add_mapping", { shortname: sn, rowType: OCC, source: "duplicate_ids" });
      assert.equal(map.isError, false, map.body);
      const p = await call("ipt_publish", { shortname: sn, summary: "will fail", confirm: true });
      assert.equal(p.isError, true, `expected a failed publication: ${p.body}`);
      const pub = await call("ipt_get_publication_status", { shortname: sn, logLines: 30 });
      assert.equal(pub.json.state, "failed");
      assert.ok(pub.json.message.length > 0);
      assert.match(pub.json.log, /dup1|duplicate|not unique|ERROR/i, pub.json.log);
      assert.equal((await call("ipt_get_status", { shortname: sn })).json.lastPublishedVersion, undefined, "no version was created");
    });

    await t.test("the resource can be deleted, but only after confirmation", async () => {
      const ask = await call("ipt_delete_resource", { shortname: sn });
      assert.equal(ask.json.needsConfirmation, true);
      assert.ok((await call("ipt_list_managed_resources")).json.some((r: any) => r.shortname === sn), "still there");
      assert.equal((await call("ipt_delete_resource", { shortname: sn, confirm: true })).isError, false);
      assert.ok(!(await call("ipt_list_managed_resources")).json.some((r: any) => r.shortname === sn), "gone");
    });
  } finally {
    await cleanup(call, sn);
    await client.close();
  }
});
