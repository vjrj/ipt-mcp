import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error plain JS module without types
import { claudeDesktopConfig, defaultInstancesFile, mergeClientConfig, mergeInstance, passwordVar } from "../scripts/install.mjs";
import { loadConfig } from "../src/config.ts";

test("installer: instances are merged, the first stays the default and the password is a variable, never a value", () => {
  let doc = mergeInstance({}, { name: "demo", url: "https://ipt-demo.example", email: "me@x.org", readonly: false });
  doc = mergeInstance(doc, { name: "prod", url: "https://ipt.example", email: "me@x.org", readonly: true });
  assert.equal(doc.default, "demo");
  assert.deepEqual(doc.instances.demo, { url: "https://ipt-demo.example", email: "me@x.org", password: "${IPT_DEMO_PASSWORD}" });
  assert.equal(doc.instances.prod.readonly, true);
  assert.equal(passwordVar("my-ipt.2"), "IPT_MY_IPT_2_PASSWORD");
  assert.ok(!JSON.stringify(doc).includes("secret"));
  // and the server accepts exactly what the installer writes
  const cfg = loadConfig({ IPT_INSTANCES: JSON.stringify(doc), IPT_DEMO_PASSWORD: "pw" });
  assert.deepEqual(cfg.instances.map((i) => [i.name, i.password, i.readonly]), [["demo", "pw", false], ["prod", undefined, true]]);
  assert.deepEqual(mergeInstance({}, { name: "pub", url: "https://x.org", email: "", readonly: false }).instances.pub, { url: "https://x.org" });
});

test("installer: the client config keeps its other servers, and paths are per platform", () => {
  const merged = mergeClientConfig({ theme: "dark", mcpServers: { other: { command: "x" } } }, "/cfg/instances.json");
  assert.equal(merged.theme, "dark");
  assert.deepEqual(Object.keys(merged.mcpServers), ["other", "ipt"]);
  assert.equal(merged.mcpServers.ipt.env.IPT_INSTANCES, "/cfg/instances.json");
  assert.match(merged.mcpServers.ipt.args.at(-1), /src[\\/]server\.ts$/);
  assert.match(defaultInstancesFile({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me"), /ipt-mcp[\\/]instances\.json$/);
  assert.match(defaultInstancesFile({}, "linux", "/home/me"), /^\/home\/me\/\.config\/ipt-mcp\/instances\.json$/);
  assert.match(claudeDesktopConfig({}, "darwin", "/Users/me"), /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
});

test("installer: end to end without npm — writes the instances file (mode 600) and merges Claude Desktop's config", () => {
  const dir = mkdtempSync(join(tmpdir(), "iptinst-"));
  const desktop = join(dir, "claude_desktop_config.json");
  writeFileSync(desktop, JSON.stringify({ mcpServers: { keep: { command: "y" } } }));
  const instances = join(dir, "ipt", "instances.json");
  const run = (extra: string[]) =>
    spawnSync(process.execPath, ["scripts/install.mjs", "--no-install", "--instances", instances, "--client", "claude-desktop", "--config", desktop, ...extra], { encoding: "utf8" });
  const a = run(["--name", "demo", "--url", "https://ipt-demo.example", "--email", "me@x.org"]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /export IPT_DEMO_PASSWORD=|setx IPT_DEMO_PASSWORD/);
  const b = run(["--name", "prod", "--url", "https://ipt.example", "--email", "me@x.org", "--readonly"]);
  assert.equal(b.status, 0, b.stderr);
  const doc = JSON.parse(readFileSync(instances, "utf8"));
  assert.deepEqual(Object.keys(doc.instances), ["demo", "prod"]);
  assert.equal(doc.default, "demo");
  assert.equal(JSON.parse(readFileSync(desktop, "utf8")).mcpServers.keep.command, "y");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(desktop, "utf8")).mcpServers), ["keep", "ipt"]);
  if (process.platform !== "win32") assert.equal(statSync(instances).mode & 0o777, 0o600);
  const bad = run(["--name", "x y", "--url", "https://a.b"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /may only contain/);
});
