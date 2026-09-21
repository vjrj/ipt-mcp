import { createReadStream } from "node:fs";

export interface TsvIssue {
  line: number;
  kind: "too_few_columns" | "too_many_columns" | "bad_integer" | "out_of_range" | "duplicate_id" | "mojibake";
  detail: string;
}

export interface TsvReport {
  ok: boolean;
  header: string[];
  expectedColumns: number;
  rows: number;
  invalidUtf8: boolean;
  counts: Record<string, number>;
  issues: TsvIssue[];
  truncated: boolean;
  hints: string[];
}

export interface TsvOptions {
  delimiter?: string;
  maxIssues?: number;
  idColumn?: string;
  /** Cap on distinct ids tracked for duplicate detection (memory guard). */
  maxTrackedIds?: number;
}

const INT_RANGES: Record<string, [number, number]> = {
  year: [1, 2100],
  month: [1, 12],
  day: [1, 31],
  startdayofyear: [1, 366],
  enddayofyear: [1, 366],
};

const FLOAT_RANGES: Record<string, [number, number]> = {
  decimallatitude: [-90, 90],
  decimallongitude: [-180, 180],
};

// Typical UTF-8 read as Latin-1/CP1252 ("Ã©", "Ã±", "Â°"), plus U+FFFD.
const MOJIBAKE = /Ã[-¿]|Â[-¿]|�/;

/**
 * Streaming validator for Darwin Core text files. Never loads the file in memory,
 * so it works for multi-GB inputs. Detects the failure mode that breaks IPT source
 * processing: rows split by embedded newlines (too few columns) or carrying
 * embedded tabs (too many columns).
 */
export async function validateTsvFile(path: string, opts: TsvOptions = {}): Promise<TsvReport> {
  const stream = createReadStream(path);
  return validateTsvStream(stream, opts);
}

export async function validateTsvStream(
  source: AsyncIterable<Buffer | string>,
  opts: TsvOptions = {},
): Promise<TsvReport> {
  const delimiter = opts.delimiter ?? "\t";
  const maxIssues = opts.maxIssues ?? 20;
  const maxTracked = opts.maxTrackedIds ?? 5_000_000;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const report: TsvReport = {
    ok: true,
    header: [],
    expectedColumns: 0,
    rows: 0,
    invalidUtf8: false,
    counts: {},
    issues: [],
    truncated: false,
    hints: [],
  };

  let idIdx = -1;
  let colIdx: Record<string, number> = {};
  const seenIds = new Set<string>();
  let idTrackingOff = false;
  let lineNo = 0;
  let carry = "";

  const bump = (k: string) => {
    report.counts[k] = (report.counts[k] ?? 0) + 1;
  };
  const add = (issue: TsvIssue) => {
    bump(issue.kind);
    if (report.issues.length < maxIssues) report.issues.push(issue);
    else report.truncated = true;
  };

  const handleLine = (raw: string) => {
    lineNo++;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (lineNo === 1) {
      report.header = line.replace(/^﻿/, "").split(delimiter).map((h) => h.trim());
      report.expectedColumns = report.header.length;
      report.header.forEach((h, i) => {
        colIdx[shortName(h)] = i;
      });
      const wanted = shortName(opts.idColumn ?? "occurrenceID");
      idIdx = colIdx[wanted] ?? -1;
      if (idIdx < 0) report.hints.push(`No "${opts.idColumn ?? "occurrenceID"}" column found in header; duplicate check skipped.`);
      return;
    }
    if (line.length === 0) return;
    report.rows++;
    const cells = line.split(delimiter);
    if (cells.length < report.expectedColumns) {
      add({ line: lineNo, kind: "too_few_columns", detail: `${cells.length}/${report.expectedColumns} columns (row split by an embedded newline?)` });
      return;
    }
    if (cells.length > report.expectedColumns) {
      add({ line: lineNo, kind: "too_many_columns", detail: `${cells.length}/${report.expectedColumns} columns (embedded tab?)` });
      return;
    }
    if (MOJIBAKE.test(line)) add({ line: lineNo, kind: "mojibake", detail: "sequence looks like UTF-8 decoded as Latin-1" });

    for (const [name, [lo, hi]] of Object.entries(INT_RANGES)) {
      const i = colIdx[name];
      const v = i === undefined ? "" : (cells[i] ?? "").trim();
      if (v === "") continue;
      if (!/^-?\d+$/.test(v)) add({ line: lineNo, kind: "bad_integer", detail: `${name}="${clip(v)}"` });
      else if (+v < lo || +v > hi) add({ line: lineNo, kind: "out_of_range", detail: `${name}=${v} not in [${lo},${hi}]` });
    }
    for (const [name, [lo, hi]] of Object.entries(FLOAT_RANGES)) {
      const i = colIdx[name];
      const v = i === undefined ? "" : (cells[i] ?? "").trim();
      if (v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) add({ line: lineNo, kind: "out_of_range", detail: `${name}="${clip(v)}" not in [${lo},${hi}]` });
    }
    if (idIdx >= 0 && !idTrackingOff) {
      const id = (cells[idIdx] ?? "").trim();
      if (id !== "") {
        if (seenIds.has(id)) add({ line: lineNo, kind: "duplicate_id", detail: `${opts.idColumn ?? "occurrenceID"}="${clip(id)}"` });
        else if (seenIds.size >= maxTracked) {
          idTrackingOff = true;
          report.hints.push(`Duplicate check stopped after ${maxTracked} distinct ids.`);
        } else seenIds.add(id);
      }
    }
  };

  try {
    for await (const chunk of source) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const parts = (carry + text).split("\n");
      carry = parts.pop() ?? "";
      for (const p of parts) handleLine(p);
    }
    carry += decoder.decode();
    if (carry.length > 0) handleLine(carry);
  } catch (e) {
    if (e instanceof TypeError) report.invalidUtf8 = true;
    else throw e;
  }

  const c = report.counts;
  if ((c["too_few_columns"] ?? 0) > 0 || (c["too_many_columns"] ?? 0) > 0) {
    report.hints.push("Rows with wrong column counts break IPT source analysis. Repair by merging split fragments and replacing embedded tabs/newlines before uploading.");
  }
  report.ok = !report.invalidUtf8 && report.issues.length === 0 && Object.keys(c).length === 0;
  return report;
}

function shortName(term: string): string {
  const t = term.trim();
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf(":"));
  return (i >= 0 ? t.slice(i + 1) : t).toLowerCase();
}

function clip(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
