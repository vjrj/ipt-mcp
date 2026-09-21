import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const emls: Record<string, string> = {
  a: "<dataset><title>Alpha</title><abstract><para>Records of plants in Spain</para></abstract><keywordSet><keyword>flora</keyword></keywordSet></dataset>",
  b: "<dataset><title>Beta</title><abstract><para>Birds</para></abstract><keywordSet><keyword>Plants</keyword></keywordSet></dataset>",
  c: "<dataset><title>Gamma</title><abstract><para>Fungi</para></abstract></dataset>",
};

test("ipt_list_datasets: query matches id/title; searchMetadata also abstract and keywords", async () => {
  const ipt = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/inventory/v2/dataset") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resources: ["a", "b", "c"].map((id) => ({ id, title: id === "c" ? "Plants of Mars" : id.toUpperCase() })) }));
    } else if (url.pathname === "/eml.do") {
      res.end(emls[url.searchParams.get("r") ?? ""] ?? "");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => ipt.listen(0, "127.0.0.1", r));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/server.ts"],
      env: { ...process.env, IPT_URL: `http://127.0.0.1:${(ipt.address() as AddressInfo).port}`, IPT_EMAIL: "", IPT_PASSWORD: "", IPT_READONLY: "" } as Record<string, string>,
    }),
  );
  try {
    const list = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "ipt_list_datasets", arguments: args })) as any).content[0].text);
    const plain = await list({ query: "plants" });
    assert.deepEqual(plain.datasets.map((d: any) => [d.id, d.matchedIn]), [["c", "id/title"]]);
    const deep = await list({ query: "plants", searchMetadata: true });
    assert.deepEqual(deep.datasets.map((d: any) => [d.id, d.matchedIn]), [["a", "abstract"], ["b", "keywords"], ["c", "id/title"]]);
    assert.equal(deep.total, 3);
    const all = await list({});
    assert.equal(all.matched, 3);
  } finally {
    await client.close();
    ipt.close();
  }
});
