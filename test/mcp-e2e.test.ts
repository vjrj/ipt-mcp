import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP protocol: tools are listed and validate_tsv works end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iptmcp-"));
  const file = join(dir, "bad.txt");
  writeFileSync(file, "occurrenceID\tname\tmonth\na1\tx\t1\na2\tfoo\nbar\t2\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    env: { ...process.env, IPT_URL: "http://127.0.0.1:1", IPT_EMAIL: "", IPT_PASSWORD: "", IPT_READONLY: "" } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const documentedFlow = [
      "ipt_create_resource", "ipt_set_basic_metadata", "ipt_set_contacts", "ipt_set_coverage", "ipt_set_keywords_methods",
      "ipt_set_metadata_fields", "ipt_replace_eml", "ipt_add_source", "ipt_configure_source", "ipt_add_mapping", "ipt_set_mapping",
      "ipt_validate_resource", "ipt_publish", "ipt_get_publication_status", "ipt_set_visibility", "ipt_set_settings", "ipt_delete_resource",
      "validate_tsv", "ipt_list_datasets", "ipt_get_status",
    ];
    for (const n of documentedFlow) assert.ok(names.includes(n), `missing tool ${n}`);
    // Anything that changes the IPT says so, and the destructive ones require an explicit confirm.
    for (const t of tools) {
      const writes = t.description?.startsWith("[writes to the IPT]");
      if (["ipt_publish", "ipt_delete_resource", "ipt_delete_source", "ipt_delete_mapping", "ipt_set_visibility", "ipt_replace_eml"].includes(t.name)) {
        assert.ok(writes, `${t.name} must be a write tool`);
        assert.ok("confirm" in ((t.inputSchema as { properties?: object }).properties ?? {}), `${t.name} needs a confirm argument`);
      }
      if (t.name.startsWith("ipt_get_") || t.name === "validate_tsv") assert.ok(!writes, `${t.name} must not be a write tool`);
    }

    const res: any = await client.callTool({ name: "validate_tsv", arguments: { path: file } });
    const report = JSON.parse(res.content[0].text);
    assert.equal(report.ok, false);
    assert.equal(report.counts.too_few_columns, 2);

    const noCreds: any = await client.callTool({ name: "ipt_list_managed_resources", arguments: {} });
    assert.equal(noCreds.isError, true);
    assert.match(noCreds.content[0].text, /IPT_EMAIL/);

    // Argument validation happens before anything reaches the IPT.
    const badName: any = await client.callTool({ name: "ipt_get_status", arguments: { shortname: "../etc" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(badName.isError, true);

    const unreachable: any = await client.callTool({ name: "ipt_health", arguments: {} });
    assert.equal(unreachable.isError, true);
  } finally {
    await client.close();
  }
});
