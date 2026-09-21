import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Redactor } from "../src/redact.ts";
import { assertReadablePath } from "../src/paths.ts";

test("Redactor masks the password wherever it appears, including URL userinfo", () => {
  const r = new Redactor(["s3cret-pw"]);
  assert.equal(r.str("login failed for s3cret-pw!"), "login failed for ***!");
  assert.equal(r.str("GET https://user:hunter2@ipt.example/ipt failed"), "GET https://***@ipt.example/ipt failed");
  assert.deepEqual(r.value({ a: ["x s3cret-pw y"], nested: { note: "s3cret-pw" } }), { a: ["x *** y"], nested: { note: "***" } });
});

test("Redactor masks by field name: object keys and {name,value} form fields", () => {
  const r = new Redactor([]);
  assert.deepEqual(r.value({ password: "abc", apiKey: "k", title: "keep" }), { password: "***", apiKey: "***", title: "keep" });
  assert.deepEqual(
    r.value([{ name: "sqlSourcePassword", value: "abc" }, { name: "source.username", value: "bob" }, { name: "csrfToken", value: "t" }]),
    [{ name: "sqlSourcePassword", value: "***" }, { name: "source.username", value: "bob" }, { name: "csrfToken", value: "***" }],
  );
});

test("Redactor ignores too-short secrets (would mangle ordinary text)", () => {
  assert.equal(new Redactor(["ab"]).str("abab"), "abab");
});

test("assertReadablePath: only real data files outside hidden paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "iptmcp-sec-"));
  const good = join(dir, "data.txt");
  writeFileSync(good, "a\tb\n");
  assert.ok(assertReadablePath(good, "data").endsWith("data.txt"));

  assert.throws(() => assertReadablePath(join(dir, "missing.txt"), "data"), /not found/);
  assert.throws(() => assertReadablePath(dir, "data"), /not a regular file/);

  const hidden = join(dir, ".ssh");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "id.txt"), "k");
  assert.throws(() => assertReadablePath(join(hidden, "id.txt"), "data"), /hidden path/);
  writeFileSync(join(dir, ".mcp.json"), "{}");
  assert.throws(() => assertReadablePath(join(dir, ".mcp.json"), "eml"), /hidden path/);

  writeFileSync(join(dir, "notes.json"), "{}");
  assert.throws(() => assertReadablePath(join(dir, "notes.json"), "data"), /unsupported file type/);
  assert.throws(() => assertReadablePath(good, "eml"), /unsupported file type/);
  assert.throws(() => assertReadablePath(good, "dwca"), /unsupported file type/);

  // A visible symlink to a hidden file is caught through the real path.
  symlinkSync(join(hidden, "id.txt"), join(dir, "innocent.txt"));
  assert.throws(() => assertReadablePath(join(dir, "innocent.txt"), "data"), /hidden path/);
});

test("assertReadablePath honours IPT_ALLOWED_DIRS", () => {
  const dir = mkdtempSync(join(tmpdir(), "iptmcp-sec-"));
  const other = mkdtempSync(join(tmpdir(), "iptmcp-sec-"));
  writeFileSync(join(dir, "a.txt"), "x");
  writeFileSync(join(other, "b.txt"), "x");
  assert.ok(assertReadablePath(join(dir, "a.txt"), "data", [dir]));
  assert.throws(() => assertReadablePath(join(other, "b.txt"), "data", [dir]), /outside IPT_ALLOWED_DIRS/);
});

test("MCP: no password in any result, even when the URL carries credentials; sensitive files are refused", async () => {
  const PW = "Sup3r-Secret-PW";
  const home = mkdtempSync(join(tmpdir(), "iptmcp-home-"));
  writeFileSync(join(home, ".mcp.json"), JSON.stringify({ token: "x" }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    env: { ...process.env, IPT_URL: `http://bob:${PW}@127.0.0.1:1/ipt`, IPT_EMAIL: "bob@example.org", IPT_PASSWORD: PW, IPT_READONLY: "" } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const all: string[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await client.callTool({ name, arguments: args });
      const body = res.content.map((c: any) => c.text).join("\n");
      all.push(body);
      return { isError: !!res.isError, body };
    };
    for (const [name, args] of [
      ["ipt_health", {}],
      ["ipt_list_datasets", {}],
      ["ipt_list_managed_resources", {}],
      ["ipt_get_status", { shortname: "x" }],
      ["ipt_create_resource", { shortname: "x", type: "occurrence" }],
    ] as const) {
      const r = await call(name, args as Record<string, unknown>);
      assert.equal(r.isError, true, name);
    }
    const hidden = await call("validate_tsv", { path: join(home, ".mcp.json") });
    assert.equal(hidden.isError, true);
    assert.match(hidden.body, /hidden path|unsupported file type/);
    const upload = await call("ipt_add_source", { shortname: "x", type: "file", path: join(home, ".mcp.json") });
    assert.equal(upload.isError, true);
    for (const body of all) assert.ok(!body.includes(PW), `password leaked in: ${body.slice(0, 200)}`);
  } finally {
    await client.close();
  }
});
