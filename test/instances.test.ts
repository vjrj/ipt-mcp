import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.ts";

test("config: a single IPT from IPT_URL/IPT_EMAIL/IPT_PASSWORD keeps working", () => {
  const c = loadConfig({ IPT_URL: "https://x.example/ipt", IPT_EMAIL: "a@b.c", IPT_PASSWORD: "pw", IPT_READONLY: "1" });
  assert.equal(c.default, "default");
  assert.deepEqual(c.instances, [{ name: "default", url: "https://x.example/ipt", email: "a@b.c", password: "pw", readonly: true }]);
  assert.equal(loadConfig({}).instances[0]!.url, "https://ipt.gbif.org");
});

test("config: several IPTs from inline JSON or a file; ${VAR} keeps passwords out of the file", () => {
  const spec = {
    default: "demo",
    instances: {
      demo: { url: "https://ipt-demo.example", email: "me@x.org", password: "${IPT_DEMO_PASSWORD}" },
      prod: { url: "https://ipt.example", email: "me@x.org", password: "${IPT_PROD_PASSWORD}", readonly: true },
    },
  };
  const env = { IPT_DEMO_PASSWORD: "demo-pw" };
  for (const IPT_INSTANCES of [JSON.stringify(spec), (() => { const f = join(mkdtempSync(join(tmpdir(), "iptcfg-")), "ipt.json"); writeFileSync(f, JSON.stringify(spec)); return f; })()]) {
    const c = loadConfig({ ...env, IPT_INSTANCES });
    assert.equal(c.default, "demo");
    assert.deepEqual(c.instances.map((i) => [i.name, i.password, i.readonly]), [["demo", "demo-pw", false], ["prod", undefined, true]], "an unset variable means: no credentials for that IPT");
  }
  assert.equal(loadConfig({ IPT_INSTANCES: JSON.stringify(spec), IPT_READONLY: "true" }).instances.every((i) => i.readonly), true, "the global switch applies to all");
});

test("config: mistakes are reported clearly", () => {
  assert.throws(() => loadConfig({ IPT_INSTANCES: "/no/such/file.json" }), /IPT_INSTANCES/);
  assert.throws(() => loadConfig({ IPT_INSTANCES: "{}" }), /at least one/);
  assert.throws(() => loadConfig({ IPT_INSTANCES: JSON.stringify({ instances: { "bad name": { url: "https://x" } } }) }), /invalid instance name/);
  assert.throws(() => loadConfig({ IPT_INSTANCES: JSON.stringify({ instances: { a: {} } }) }), /url is missing/);
  assert.throws(() => loadConfig({ IPT_INSTANCES: JSON.stringify({ default: "zz", instances: { a: { url: "https://x" } } }) }), /default instance "zz"/);
});

const fakeIpt = async (title: string): Promise<Server> => {
  const s = createServer((req, res) => {
    if (req.url?.startsWith("/login.do")) {
      // just enough of the IPT login: a CSRF token on GET, a redirect on POST
      if (req.method === "POST") {
        res.statusCode = 302;
        res.setHeader("location", "/home.do");
        res.end();
      } else {
        res.end('<input type="hidden" name="csrfToken" value="t"/>');
      }
    } else if (req.url?.startsWith("/inventory/v2/dataset")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resources: [{ id: title, title }] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return s;
};
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

test("MCP: every tool takes an instance; the default is used otherwise; read-only is per IPT; no credentials are shown", async () => {
  const [demo, prod, stage] = [await fakeIpt("from-demo"), await fakeIpt("from-prod"), await fakeIpt("from-stage")];
  const PW = "Pr0d-Secret-PW";
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/server.ts"],
      env: {
        ...process.env,
        IPT_PROD_PASSWORD: PW,
        IPT_INSTANCES: JSON.stringify({
          default: "demo",
          instances: {
            demo: { url: urlOf(demo) },
            stage: { url: urlOf(stage), email: "me@x.org", password: "stage-pw" },
            prod: { url: urlOf(prod), email: "bob@x.org", password: "${IPT_PROD_PASSWORD}", readonly: true },
          },
        }),
      } as Record<string, string>,
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const body = res.content.map((c: any) => c.text).join("\n");
    return { isError: !!res.isError, body, json: (() => { try { return JSON.parse(body); } catch { return undefined; } })() };
  };
  try {
    const { tools } = await client.listTools();
    for (const t of tools.filter((t) => t.name !== "ipt_list_instances" && t.name !== "validate_tsv")) {
      assert.ok("instance" in ((t.inputSchema as { properties?: object }).properties ?? {}), `${t.name} lacks the instance argument`);
    }
    const ids = async (args: Record<string, unknown>) => { const r = await call("ipt_list_datasets", args); assert.equal(r.isError, false, r.body); return r.json.datasets.map((d: any) => d.id); };
    assert.deepEqual(await ids({}), ["from-demo"], "default instance");
    assert.deepEqual(await ids({ instance: "prod" }), ["from-prod"]);
    assert.deepEqual(await ids({ instance: "demo" }), ["from-demo"]);
    const unknown = await call("ipt_list_datasets", { instance: "nope" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.body, /unknown IPT instance "nope"; configured: demo, stage, prod/);

    const list = await call("ipt_list_instances");
    assert.deepEqual(list.json.map((i: any) => [i.name, i.default, i.credentials, i.readonly]), [["demo", true, false, false], ["stage", false, true, false], ["prod", false, true, true]]);
    assert.ok(!list.body.includes(PW), "no credentials in the instance list");

    const ro = await call("ipt_delete_resource", { shortname: "x", confirm: true, instance: "prod" });
    assert.equal(ro.isError, true);
    assert.match(ro.body, /"prod" is read-only/);
    const noCreds = await call("ipt_delete_resource", { shortname: "x", confirm: true });
    assert.match(noCreds.body, /No credentials configured for the IPT instance "demo"/);
    // a confirmation names the IPT it is about, so "yes" cannot be mistaken for another one
    const ask = await call("ipt_delete_resource", { shortname: "x", instance: "stage" });
    assert.equal(ask.json.needsConfirmation, true);
    assert.equal(ask.json.instance, "stage");
    assert.equal(ask.json.url, urlOf(stage));
    for (const r of [unknown, list, ro, noCreds]) assert.ok(!r.body.includes(PW));
  } finally {
    await client.close();
    demo.close();
    prod.close();
    stage.close();
  }
});
