import { test } from "node:test";
import assert from "node:assert/strict";
import { IptClient } from "../src/ipt-client.ts";
import { IptManager, assertShortname } from "../src/manager.ts";

/** A scripted fake IPT: routes by "METHOD /path" and records the posted bodies. */
function fake(routes: Record<string, (body: URLSearchParams | undefined) => Response>) {
  const posts: Array<{ path: string; body: URLSearchParams }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${u.pathname}`;
    const body = init?.body instanceof URLSearchParams ? init.body : undefined;
    if (method === "POST" && body) posts.push({ path: u.pathname + u.search, body });
    const h = routes[key];
    if (!h) return new Response(`no route ${key}`, { status: 404 });
    return h(body);
  };
  return { m: new IptManager(new IptClient("https://ipt.example/ipt", fetchImpl)), posts };
}

const contactsPage = `<form action="metadata-contacts.do" method="post">
  <input type="hidden" name="metadata-section" value="contacts">
  <input name="eml.contact.firstName" value=""><input name="eml.creator.firstName" value="">
  <input name="eml.contacts[0].firstName" value="Old"><input name="eml.contacts[0].lastName" value="Contact">
  <input name="eml.creators[0].firstName" value="Cre"><input name="eml.creators[0].lastName" value="Ator">
  <input name="country" value=""><input name="baseItem-email-input" value=""><input type="hidden" name="r" value="x">
</form>`;

test("shortname validation blocks path/param injection", () => {
  for (const bad of ["", "a b", "../x", "a&b=c", "a/b", "x?y"]) assert.throws(() => assertShortname(bad), /invalid resource shortname/, bad);
  for (const good of ["abc", "A_b-1.2"]) assert.doesNotThrow(() => assertShortname(good));
});

test("setAgents posts only indexed rows, replaces the given list and keeps the others", async () => {
  const { m, posts } = fake({
    "GET /ipt/manage/metadata-contacts.do": () => new Response(contactsPage),
    "POST /ipt/manage/metadata-contacts.do": () => new Response(null, { status: 302, headers: { location: "/ipt/manage/metadata-acknowledgements.do?r=x" } }),
  });
  await m.client.getHtml("/x").catch(() => undefined);
  const r = await m.setAgents("x", { contacts: [{ firstName: "New", lastName: "One", email: "n@o.org" }] });
  assert.equal(r.ok, true);
  const names = [...(posts[0]?.body.keys() ?? [])].sort();
  assert.deepEqual(names, ["eml.contacts[0].email[0]", "eml.contacts[0].firstName", "eml.contacts[0].lastName", "eml.creators[0].firstName", "eml.creators[0].lastName", "metadata-section", "r", "save"].sort());
  assert.equal(posts[0]?.body.get("eml.contacts[0].firstName"), "New");
  assert.equal(posts[0]?.body.get("eml.creators[0].firstName"), "Cre", "creators untouched");
});

test("a 200 response from a save is reported as failure with the IPT's messages", async () => {
  const { m } = fake({
    "GET /ipt/manage/metadata-contacts.do": () => new Response(contactsPage),
    "POST /ipt/manage/metadata-contacts.do": () => new Response(`<div class="alert-danger">At least one creator is required</div>`),
  });
  const r = await m.setAgents("x", { contacts: [{ lastName: "L" }] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["At least one creator is required"]);
});

test("coverage helpers reject impossible input before touching the IPT", async () => {
  const { m, posts } = fake({});
  await assert.rejects(() => m.setGeographicCoverage("x", [{ minLatitude: 10, maxLatitude: 5, minLongitude: 0, maxLongitude: 1 }]), /minLatitude > maxLatitude/);
  await assert.rejects(() => m.setGeographicCoverage("x", [{ minLatitude: 0, maxLatitude: 5, minLongitude: 10, maxLongitude: 1 }]), /antimeridian/);
  await assert.rejects(() => m.setTemporalCoverage("x", [{ startDate: "2020/01/01" }]), /not yyyy-mm-dd/);
  await assert.rejects(() => m.setTemporalCoverage("x", [{ startDate: "2020-02-01", endDate: "2020-01-01" }]), /endDate before startDate/);
  assert.equal(posts.length, 0);
});

test("relogin: an expired session is renewed once and the request retried", async () => {
  let logins = 0;
  let expired = false;
  const html = `<div id="publish"></div>`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    if (u.pathname === "/ipt/login.do" && method === "GET") return new Response('<input name="csrfToken" value="t">');
    if (u.pathname === "/ipt/login.do" && method === "POST") {
      logins++;
      expired = false;
      return new Response(null, { status: 302, headers: { location: "/ipt/" } });
    }
    if (u.pathname === "/ipt/manage/resource.do") {
      return expired ? new Response(null, { status: 302, headers: { location: "https://ipt.example/ipt/login.do" } }) : new Response(html);
    }
    return new Response("?", { status: 404 });
  };
  const c = new IptClient("https://ipt.example/ipt", fetchImpl);
  await c.login({ email: "a", password: "b" });
  const m = new IptManager(c);
  expired = true;
  const st = await m.getStatus("x");
  assert.equal(st.shortname, "x");
  assert.equal(logins, 2, "initial login + one transparent relogin");
});
