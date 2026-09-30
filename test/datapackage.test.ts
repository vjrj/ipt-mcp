import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IptClient } from "../src/ipt-client.ts";
import { IptManager, droppedKeys, parseDatapackageJson } from "../src/manager.ts";

/** A scripted fake IPT that also records multipart posts. */
function fake(routes: Record<string, (u: URL) => Response>) {
  const posts: Array<{ path: string; form: FormData }> = [];
  const gets: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST" && init?.body instanceof FormData) posts.push({ path: u.pathname, form: init.body });
    if (method === "GET") gets.push(u.pathname + u.search);
    const h = routes[`${method} ${u.pathname}`];
    return h ? h(u) : new Response(`no route ${method} ${u.pathname}`, { status: 404 });
  };
  return { m: new IptManager(new IptClient("https://ipt.example/ipt", fetchImpl)), posts, gets };
}

const overview = (json: string, extra = "") => `<html><body>${extra}<pre id="json-raw-data" class="fs-smaller-2">${json}</pre></body></html>`;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function tmpJson(v: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), "dp-")), "datapackage.json");
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
}

test("parseDatapackageJson refuses broken JSON and non-descriptors", () => {
  assert.throws(() => parseDatapackageJson("{nope"), /not valid JSON/);
  assert.throws(() => parseDatapackageJson("[1]"), /must be a JSON object/);
  assert.throws(() => parseDatapackageJson('{"title":"x"}'), /neither "profile" nor "resources"/);
  assert.deepEqual(parseDatapackageJson('{"profile":"p"}'), { profile: "p" });
});

test("droppedKeys lists nested properties the IPT did not keep, ignoring empty ones", () => {
  const sent = { profile: "p", custom: 1, empty: "", none: null, list: [], project: { title: "t", samplingDesign: "x", extra: true }, gbifIngestion: { observationLevel: "event" } };
  const kept = { profile: "p", project: { title: "t", samplingDesign: "x" }, gbifIngestion: { observationLevel: "event" } };
  assert.deepEqual(droppedKeys(sent, kept), ["custom", "project.extra"]);
});

test("getDatapackageMetadata reads the draft the IPT embeds in the overview (ColDP), HTML-escaped", async () => {
  const dp = { profile: "https://example.org/coldp-profile.json", title: "Col <A & B>" };
  const { m, gets } = fake({ "GET /ipt/manage/resource.do": () => new Response(overview(escapeHtml(JSON.stringify(dp)))) });
  assert.deepEqual(await m.getDatapackageMetadata("col"), { source: "draft", metadata: dp });
  assert.deepEqual(gets, ["/ipt/manage/resource.do?r=col"]);
});

test("getDatapackageMetadata falls back to the last published version when the draft is not shown (Camtrap DP)", async () => {
  const dp = { profile: "camtrap", title: "Cams", version: "3" };
  const { m, gets } = fake({
    "GET /ipt/manage/resource.do": () => new Response(overview("")),
    "GET /ipt/metadata.do": () => new Response(JSON.stringify(dp), { headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(await m.getDatapackageMetadata("cams"), { source: "published", metadata: dp });
  assert.deepEqual(gets, ["/ipt/manage/resource.do?r=cams", "/ipt/metadata.do?r=cams"]);
  const unpublished = fake({ "GET /ipt/manage/resource.do": () => new Response(overview("")) });
  await assert.rejects(unpublished.m.getDatapackageMetadata("cams"), /no published version yet/);
});

test("getDatapackageMetadata explains that a DwC resource has no data package metadata", async () => {
  const { m } = fake({ "GET /ipt/manage/resource.do": () => new Response("<html><body>overview</body></html>") });
  await assert.rejects(m.getDatapackageMetadata("occ"), /not a data package resource/);
});

test("replaceDatapackageMetadata posts the file with the overview form's fields and reports dropped properties", async () => {
  const sent = { profile: "p", id: "x", created: "2020-01-01", title: "T", unknownThing: 1, project: { title: "P", foo: "bar" } };
  const stored = { profile: "p", name: "cams", title: "T", project: { title: "P" } };
  const { m, posts } = fake({
    "POST /ipt/manage/replace-datapackage-metadata.do": () => new Response(null, { status: 302, headers: { location: "/ipt/manage/resource.do?r=cams" } }),
    "GET /ipt/manage/resource.do": () => new Response(overview(JSON.stringify(stored), `<div class="alert-success">Metadata replaced</div>`)),
  });
  const r = await m.replaceDatapackageMetadata("cams", tmpJson(sent), true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.dropped, ["unknownThing", "project.foo"], "id/created are reset by the IPT, not reported");
  const form = posts[0]?.form;
  assert.equal(posts[0]?.path, "/ipt/manage/replace-datapackage-metadata.do");
  assert.equal(form?.get("r"), "cams");
  assert.equal(form?.get("validateDatapackageMetadata"), "true");
  assert.equal(form?.get("datapackageMetadataReplace"), "Replace");
  const file = form?.get("datapackageMetadataFile");
  assert.ok(file instanceof Blob, "the JSON goes as a file part");
  assert.deepEqual(JSON.parse(await file.text()), sent);
});

test("replaceDatapackageMetadata says when dropped properties cannot be checked (draft not shown)", async () => {
  const { m } = fake({
    "POST /ipt/manage/replace-datapackage-metadata.do": () => new Response(null, { status: 302, headers: { location: "/ipt/manage/resource.do?r=cams" } }),
    "GET /ipt/manage/resource.do": () => new Response(overview("")),
  });
  const r = await m.replaceDatapackageMetadata("cams", tmpJson({ profile: "p", custom: 1 }));
  assert.equal(r.ok, true);
  assert.equal(r.dropped, undefined);
  assert.match(r.note ?? "", /publish, then compare/);
});

test("replaceDatapackageMetadata surfaces the IPT's validation error", async () => {
  const { m } = fake({
    "POST /ipt/manage/replace-datapackage-metadata.do": () => new Response(null, { status: 302, headers: { location: "/ipt/manage/resource.do?r=cams" } }),
    "GET /ipt/manage/resource.do": () => new Response(overview("{}", `<div class="alert-danger">Validation of the metadata file failed</div>`)),
  });
  const r = await m.replaceDatapackageMetadata("cams", tmpJson({ profile: "p" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["Validation of the metadata file failed"]);
});

test("replaceDatapackageMetadata refuses an invalid file before contacting the IPT", async () => {
  const { m, posts } = fake({});
  await assert.rejects(m.replaceDatapackageMetadata("cams", tmpJson("{broken")), /not valid JSON/);
  assert.equal(posts.length, 0);
});

test("cancelPublication reports success, and the IPT's refusal as failure", async () => {
  const ok = fake({ "GET /ipt/manage/cancel.do": () => new Response(`<div class="alert-success">Publishing version 2.0 of resource cams cancelled</div>`) });
  assert.equal((await ok.m.cancelPublication("cams")).ok, true);
  assert.deepEqual(ok.gets, ["/ipt/manage/cancel.do?r=cams"]);
  const ko = fake({ "GET /ipt/manage/cancel.do": () => new Response(`<div class="alert-danger">Failed to stop publishing</div>`) });
  const r = await ko.m.cancelPublication("cams");
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["Failed to stop publishing"]);
});
