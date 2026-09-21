import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTsvStream } from "../src/validate-tsv.ts";

const H = "occurrenceID\tscientificName\tyear\tmonth\tday\tdecimalLatitude\tdecimalLongitude";
const stream = async function* (parts: Array<string | Buffer>) {
  for (const p of parts) yield typeof p === "string" ? Buffer.from(p) : p;
};
const run = (body: string, opts = {}) => validateTsvStream(stream([body]), opts);

test("clean file passes", async () => {
  const r = await run(`${H}\na1\tQuercus ilex\t2020\t5\t12\t39.5\t-0.4\na2\tPinus\t2021\t\t\t\t\n`);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 2);
  assert.equal(r.expectedColumns, 7);
});

test("row split by embedded newline is reported as too_few_columns", async () => {
  const r = await run(`${H}\na1\tQuercus\nilex\t2020\t5\t12\t39.5\t-0.4\n`);
  assert.equal(r.ok, false);
  assert.equal(r.counts["too_few_columns"], 2);
  assert.match(r.hints.join(" "), /embedded/i);
});

test("embedded tab is reported as too_many_columns", async () => {
  const r = await run(`${H}\na1\tQuercus\tilex\t2020\t5\t12\t39.5\t-0.4\n`);
  assert.equal(r.counts["too_many_columns"], 1);
});

test("non-integer and out-of-range date parts and coordinates", async () => {
  const r = await run(`${H}\na1\tX\t2020\tMay\t12\t39.5\t-0.4\na2\tX\t2020\t13\t1\t95\t-0.4\n`);
  assert.equal(r.counts["bad_integer"], 1);
  assert.equal(r.counts["out_of_range"], 2);
});

test("duplicate occurrenceID", async () => {
  const r = await run(`${H}\na1\tX\t2020\t1\t1\t\t\na1\tY\t2020\t1\t1\t\t\n`);
  assert.equal(r.counts["duplicate_id"], 1);
});

test("mojibake detected", async () => {
  const r = await run(`${H}\na1\tCoruÃ±a\t2020\t1\t1\t\t\n`);
  assert.equal(r.counts["mojibake"], 1);
});

test("invalid UTF-8 flagged", async () => {
  const r = await validateTsvStream(stream([Buffer.from(H + "\na1\t"), Buffer.from([0xe9, 0x0a])]));
  assert.equal(r.invalidUtf8, true);
  assert.equal(r.ok, false);
});

test("multi-byte char and CRLF split across chunk boundaries", async () => {
  const buf = Buffer.from(`${H}\r\na1\tñandú\t2020\t1\t1\t\t\r\na2\tb\t2020\t1\t1\t\t\r\n`);
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 3) parts.push(buf.subarray(i, i + 3));
  const r = await validateTsvStream(stream(parts));
  assert.equal(r.ok, true);
  assert.equal(r.rows, 2);
});

test("issue list is capped but counts are complete", async () => {
  const bad = Array.from({ length: 50 }, (_, i) => `a${i}\tX`).join("\n");
  const r = await run(`${H}\n${bad}\n`, { maxIssues: 5 });
  assert.equal(r.issues.length, 5);
  assert.equal(r.counts["too_few_columns"], 50);
  assert.equal(r.truncated, true);
});

test("header with URI terms and custom id column", async () => {
  const r = await run("http://rs.tdwg.org/dwc/terms/eventID\thttp://rs.tdwg.org/dwc/terms/month\ne1\t1\ne1\t2\n", { idColumn: "eventID" });
  assert.equal(r.counts["duplicate_id"], 1);
});
