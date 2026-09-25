import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const URL = process.env["IPT_TEST_URL"];
export const skip = URL ? false : "IPT_TEST_URL not set";
export const fx = (f: string) => new globalThis.URL(`../fixtures/${f}`, import.meta.url).pathname;
export const OCC = "http://rs.tdwg.org/dwc/terms/Occurrence";
export const TAXON = "http://rs.tdwg.org/dwc/terms/Taxon";
export const uniq = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const ADA = { firstName: "Ada", lastName: "Lovelace", organisation: "Test Org", email: "ada@example.org" };
export const tmp = () => mkdtempSync(join(tmpdir(), "iptmcp-it-"));
export const write = (dir: string, name: string, content: string | Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

export interface Reply {
  isError: boolean;
  body: string;
  json: any;
}
export type Call = (name: string, args?: Record<string, unknown>) => Promise<Reply>;

/** An MCP client talking to a freshly spawned ipt-mcp server (real protocol over stdio). */
export async function connect(extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    env: {
      ...process.env,
      IPT_URL: URL!,
      IPT_EMAIL: process.env["IPT_TEST_EMAIL"] ?? "admin@example.org",
      IPT_PASSWORD: process.env["IPT_TEST_PASSWORD"] ?? "Passw0rd-test",
      IPT_READONLY: "",
      ...extraEnv,
    } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const call: Call = async (name, args = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const body = res.content.map((c: any) => c.text).join("\n");
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    return { isError: !!res.isError, body, json };
  };
  return { client, call };
}

/** Create a resource with valid metadata through the tools. Returns the shortname. */
export async function newResource(call: Call, prefix: string, opts: { type?: string; title?: string; description?: string } = {}) {
  const sn = uniq(prefix);
  const c = await call("ipt_create_resource", { shortname: sn, type: opts.type ?? "occurrence" });
  if (c.isError) throw new Error(`create failed: ${c.body}`);
  const b = await call("ipt_set_basic_metadata", {
    shortname: sn,
    title: opts.title ?? `Coverage test ${sn}`,
    description: opts.description ?? "Dataset created by the ipt-mcp integration test-suite with invented records, only to exercise the publication workflow.",
    license: "cczero",
    language: "eng",
  });
  if (b.isError) throw new Error(`basic metadata failed: ${b.body}`);
  const a = await call("ipt_set_contacts", { shortname: sn, contacts: [ADA], creators: [ADA] });
  if (a.isError) throw new Error(`contacts failed: ${a.body}`);
  return sn;
}

/** Add a data file and map it (automap) to a row type. */
export async function addAndMap(call: Call, sn: string, path: string, rowType = OCC, source?: string) {
  const add = await call("ipt_add_source", { shortname: sn, type: "file", path });
  if (add.isError) throw new Error(`add source failed: ${add.body}`);
  const map = await call("ipt_add_mapping", { shortname: sn, rowType, source: source ?? add.json.source });
  if (map.isError) throw new Error(`add mapping failed: ${map.body}`);
  return { source: add.json.source as string, mid: (map.json.mid ?? 0) as number };
}

export const publishAndWait = async (call: Call, sn: string, summary = "test") => call("ipt_publish", { shortname: sn, summary, confirm: true });

/** Make a resource public: the change applies with the next publication. */
export async function makePublic(call: Call, sn: string) {
  const v = await call("ipt_set_visibility", { shortname: sn, visibility: "public", confirm: true });
  if (v.isError) throw new Error(v.body);
  const p = await publishAndWait(call, sn, "public");
  if (p.isError) throw new Error(p.body);
}

/** Read a file out of the public DwC-A of a resource (needs the `unzip` binary). */
export async function archiveFile(sn: string, name: string): Promise<string> {
  const res = await fetch(`${URL}/archive.do?r=${sn}`);
  if (!res.ok) throw new Error(`archive.do -> HTTP ${res.status}`);
  const dir = tmp();
  const zip = write(dir, "a.zip", Buffer.from(await res.arrayBuffer()));
  return execFileSync("unzip", ["-p", zip, name], { encoding: "utf8" });
}

/**
 * Retry `fn` until it returns a truthy value or the attempts run out (250ms apart by default).
 * Use it for the IPT's own eventual consistency, e.g. peek.do briefly lagging just after an analyse
 * (see DEVELOPMENT.md); never to paper over a real assertion failure — the last result is returned as is.
 */
export async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, attempts = 5, delayMs = 250): Promise<T> {
  let v = await fn();
  for (let i = 1; i < attempts && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    v = await fn();
  }
  return v;
}

export const draftEml = async (call: Call, sn: string) => (await call("ipt_get_draft_eml", { shortname: sn })).body;
export const cleanup = async (call: Call, ...sns: string[]) => {
  for (const sn of sns) await call("ipt_delete_resource", { shortname: sn, confirm: true }).catch(() => undefined);
};
