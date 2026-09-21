import { test } from "node:test";
import assert from "node:assert/strict";
import { IptClient, summarizeEml } from "../src/ipt-client.ts";

/** Fake IPT implementing just the login + CSRF flow and a couple of JSON endpoints. */
function fakeIpt(opts: { password: string }) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    if (url.pathname === "/login.do" && method === "GET") {
      const h = new Headers();
      h.append("set-cookie", "CSRFtoken=tok123; Path=/; HttpOnly");
      h.append("set-cookie", "JSESSIONID=sess1; Path=/; HttpOnly");
      return new Response('<form><input type="hidden" name="csrfToken" value="tok123"></form>', { headers: h });
    }
    if (url.pathname === "/login.do" && method === "POST") {
      const b = init?.body as URLSearchParams;
      const csrfOk = b.get("csrfToken") === "tok123" && cookie.includes("CSRFtoken=tok123");
      if (csrfOk && b.get("password") === opts.password) return new Response(null, { status: 302, headers: { location: "/" } });
      return new Response("<form>wrong</form>", { status: 200 });
    }
    if (url.pathname === "/manager-api/resources") return Response.json({ aaData: [["<a href='https://x/manage/resource?r=r1'>One</a>", "Occurrence"]], iTotalRecords: 1 });
    if (url.pathname === "/inventory/v2/dataset") {
      return Response.json({ resources: [{ id: "a", title: "A", records: 3, additionalProperties: { core: "OCCURRENCE" }, archive: [{ url: "u" }] }] });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("login sends CSRF token+cookie and unlocks manager API", async () => {
  const { fetchImpl } = fakeIpt({ password: "pw" });
  const c = new IptClient("https://ipt.example/", fetchImpl);
  await assert.rejects(() => c.listManagedResources(), /Not logged in/);
  await c.login({ email: "a@b.c", password: "pw" });
  assert.deepEqual(await c.listManagedResources(), [{ shortname: "r1", title: "One", cells: ["Occurrence"] }]);
});

test("wrong password fails without leaking it", async () => {
  const { fetchImpl } = fakeIpt({ password: "pw" });
  const c = new IptClient("https://ipt.example", fetchImpl);
  await assert.rejects(
    () => c.login({ email: "a@b.c", password: "SECRET-BAD" }),
    (e: Error) => /wrong email\/password/.test(e.message) && !e.message.includes("SECRET-BAD"),
  );
});

test("login page without csrf field is a clear error", async () => {
  const c = new IptClient("https://x", async () => new Response("<html/>"));
  await assert.rejects(() => c.login({ email: "a", password: "b" }), /csrfToken/);
});

test("HTTP errors carry status and path only", async () => {
  const c = new IptClient("https://x", async () => new Response("boom", { status: 500 }));
  await assert.rejects(() => c.health(), /GET \/api\/health -> HTTP 500/);
});

test("listDatasets maps inventory JSON", async () => {
  const { fetchImpl } = fakeIpt({ password: "pw" });
  const [d] = await new IptClient("https://x", fetchImpl).listDatasets();
  assert.equal(d?.id, "a");
  assert.equal(d?.core, "OCCURRENCE");
  assert.equal(d?.archiveUrl, "u");
});

test("summarizeEml extracts title, abstract, contacts", () => {
  const xml = `<eml><dataset><title>T &amp; co</title><contact/><abstract><para>Hello  <b>world</b></para></abstract></dataset></eml>`;
  const s = summarizeEml(xml.replace("<contact/>", "<contact></contact>"));
  assert.equal(s.title, "T &amp; co");
  assert.equal(s.abstract, "Hello world");
  assert.equal(s.contacts, 1);
});

test("listManagedResources fetches every page and turns rows into {shortname,title,cells}", async () => {
  const total = 250;
  const rows = Array.from({ length: total }, (_, i) => [`<img>`, `<a class='resource-table-link' href='https://ipt.example/manage/resource?r=res_${i}'>Title ${i}</a>`, "Occurrence", "Private"]);
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/login.do" && !init?.method) return new Response('<input name="csrfToken" value="t">');
    if (u.pathname === "/login.do") return new Response(null, { status: 302, headers: { location: "/" } });
    if (u.pathname === "/manager-api/resources") {
      const start = Number(u.searchParams.get("start")), length = Number(u.searchParams.get("length"));
      seen.push(`${start}+${length}`);
      return Response.json({ aaData: rows.slice(start, start + Math.min(length, 100)), iTotalRecords: total });
    }
    return new Response("", { status: 404 });
  };
  const c = new IptClient("https://ipt.example", fetchImpl);
  await c.login({ email: "a", password: "b" });
  const all = await c.listManagedResources();
  assert.equal(all.length, total);
  assert.equal(new Set(all.map((r) => r.shortname)).size, total);
  assert.deepEqual(all[3], { shortname: "res_3", title: "Title 3", cells: ["Occurrence", "Private"] });
  assert.deepEqual(seen, ["0+100", "100+100", "200+100"]);
});
