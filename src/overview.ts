import { load } from "./html.ts";

const txt = (s: string) => s.replace(/\s+/g, " ").trim();

export interface SourceInfo {
  name: string;
  /** Human text from the IPT, e.g. "411 bytes | 5 rows/7 columns | 21 Sept 2026". */
  details: string;
  rows?: number;
  columns?: number;
}

export interface MappingInfo {
  rowType: string;
  mid: number;
  /** Human text from the IPT, e.g. "occurrences Darwin Core Occurrence 7 terms | ...". */
  description: string;
}

export interface ResourceStatus {
  shortname: string;
  /** Normalised visibility; "unknown" when the page text is not recognised (non-English IPT without the locale pin). */
  visibility: "public" | "private" | "registered" | "deleted" | "unknown";
  /** The IPT's own wording, for humans. */
  visibilityText: string;
  sources: SourceInfo[];
  mappings: MappingInfo[];
  /** Text of the metadata block, includes the IPT's own "Valid"/"Invalid" verdict. */
  metadata: string;
  /** Per-section problems the IPT itself reports for the metadata (empty when valid). */
  metadataProblems: Array<{ section: string; messages: string[] }>;
  /** Text of the publication block (published versions, next version). */
  publication: string;
  /** Version currently published (e.g. "1.0"); absent when never published. */
  lastPublishedVersion?: string;
  /** Version the next publication will create. */
  nextVersion?: string;
  /** A visibility change (public/private) was requested and applies at the next publication. */
  visibilityChangePending: boolean;
  publishing: boolean;
}

/** Parse the manager overview page (/manage/resource.do?r=…) into a structured status. */
export function parseOverview(shortname: string, html: string): ResourceStatus {
  const $ = load(html);
  const block = (id: string) => txt($(`#${id}`).first().text());

  const sources: SourceInfo[] = $("#sources .source-item")
    .toArray()
    .map((el) => {
      const item = $(el);
      const href = item.find("a[href*='source.do']").first().attr("href") ?? "";
      const name = new URLSearchParams(href.split("?")[1] ?? "").get("id") ?? txt(item.find("a").first().text());
      const details = txt(item.text());
      const m = details.match(/([\d.,]+)\s+\S+\s*\/\s*([\d.,]+)\s+\S+/);
      return { name, details, ...(m ? { rows: Number(m[1]!.replace(/[.,]/g, "")), columns: Number(m[2]!.replace(/[.,]/g, "")) } : {}) };
    });

  const seen = new Set<string>();
  const mappings: MappingInfo[] = [];
  for (const a of $("#mappings a[href^='mapping.do']").toArray()) {
    const href = $(a).attr("href") ?? "";
    const qs = new URLSearchParams(href.split("?")[1] ?? "");
    const key = `${qs.get("id")}#${qs.get("mid")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = $(a).closest(".mapping-item, .source-item, [class*='item']");
    const description = txt(item.length ? item.text() : $(a).parent().parent().text());
    mappings.push({ rowType: qs.get("id") ?? "", mid: Number(qs.get("mid") ?? 0), description });
  }

  const metadataProblems = $("#metadata-validation-result-modal .modal-body .mt-2 > div")
    .toArray()
    .map((d) => ({
      section: txt($(d).find("b").first().text()),
      messages: $(d).find("li").toArray().map((li) => txt($(li).text())),
    }))
    .filter((x) => x.section !== "");

  const publication = block("publish");
  const versionOf = (pill: string) => {
    const box = $(`#publish .${pill}`).first().closest("div");
    return txt(box.find("strong").first().text()).match(/Version (\d+(?:\.\d+)*)/)?.[1];
  };
  const lastPublishedVersion = versionOf("version-current");
  const nextVersion = versionOf("version-next");
  const badge = txt($("#visibility").find(".badge").first().text()) || txt($(".badge").first().text());
  const visibilityText = block("visibility");
  const visibility = normaliseVisibility(badge, visibilityText);

  return {
    shortname,
    visibility,
    visibilityText,
    sources,
    mappings,
    metadata: block("metadata"),
    metadataProblems,
    publication,
    ...(lastPublishedVersion ? { lastPublishedVersion } : {}),
    ...(nextVersion ? { nextVersion } : {}),
    visibilityChangePending: /visibility has been changed|has been changed to/i.test(block("visibility")),
    publishing: false,
  };
}

function normaliseVisibility(badge: string, text: string): ResourceStatus["visibility"] {
  const b = badge.toLowerCase();
  if (b === "public" || b === "private" || b === "registered") return b;
  if (/deleted/i.test(b) || /deleted but public/i.test(text)) return "deleted";
  // "This resource is public …" / "… is private to managers" / "… registered …" (a pending change mentions both states)
  const current = text.match(/(?:resource|recurso) (?:is|es)(?: currently)? (public|private|registered)/i)?.[1] ?? text.match(/currently (public|private|registered)/i)?.[1];
  if (current) return current.toLowerCase() as ResourceStatus["visibility"];
  return "unknown";
}

export interface PublicationReport {
  state: "running" | "completed" | "failed" | "unknown";
  message?: string;
}

/** Parse /manage/report.do?r=… */
export function parseReport(html: string): PublicationReport {
  const $ = load(html);
  const danger = txt($(".alert-danger").first().text());
  if (danger) return { state: "failed", message: danger };
  const ok = txt($(".alert-success").first().text());
  if (ok) return { state: "completed", message: ok };
  if ($(".inline-spinner").length > 0) return { state: "running" };
  return { state: "unknown" };
}

export interface FieldRow {
  /** Qualified name as shown by the IPT, e.g. "dwc:basisOfRecord". */
  qualName: string;
  /** Full term URI when available. */
  uri?: string;
  required: boolean;
  indexParam: string;
  defaultParam?: string;
  /** Selected source column index, if any. */
  index?: number;
  defaultValue: string;
}

export interface MappingPage {
  columns: string[];
  idColumn?: number;
  fields: FieldRow[];
}

/** Parse the field-mapping page (mapping.do?r=…&id=…&mid=…). */
export function parseMappingPage(html: string): MappingPage {
  const $ = load(html);
  const columns: string[] = [];
  const firstSel = $("select.fidx").first();
  firstSel.find("option").each((_, o) => {
    const v = $(o).attr("value");
    if (v !== undefined && v !== "") columns[Number(v)] = txt($(o).text());
  });
  const idSel = $("select[name='mapping.idColumn']").first().find("option[selected]").attr("value");

  const fields: FieldRow[] = [];
  for (const sel of $("select.fidx").toArray()) {
    const s = $(sel);
    const name = s.attr("name") ?? "";
    const i = name.match(/^fields\[(\d+)\]\.index$/)?.[1];
    if (i === undefined) continue;
    const row = s.closest(".mappingRow");
    const qual = txt(row.find(".field-label__original").first().text());
    const popover = row.find("a.popover-link").first().attr("data-bs-content") ?? "";
    const uri = popover.match(/href=&quot;([^&]+)&quot;|href="([^"]+)"/);
    const selected = s.find("option[selected]").attr("value");
    const defParam = `fields[${i}].defaultValue`;
    const defInput = $(`[name='${defParam.replace(/([[\]])/g, "\\$1")}']`).first();
    // Vocabulary terms (e.g. basisOfRecord) offer their default as a <select>: use the chosen option, not the option texts.
    const isSelect = (defInput.get(0) as { tagName?: string } | undefined)?.tagName?.toLowerCase() === "select";
    const defaultValue = isSelect ? defInput.find("option[selected]").attr("value") ?? "" : defInput.attr("value") ?? defInput.text() ?? "";
    fields.push({
      qualName: qual,
      ...(uri ? { uri: uri[1] ?? uri[2] } : {}),
      required: txt(row.find(".field-label__main .text-gbif-danger").text()).includes("*"),
      indexParam: name,
      defaultParam: defParam,
      ...(selected !== undefined && selected !== "" ? { index: Number(selected) } : {}),
      defaultValue,
    });
  }
  return { columns, ...(idSel !== undefined && idSel !== "" ? { idColumn: Number(idSel) } : {}), fields };
}

export interface VersionRow {
  version: string;
  published?: string;
  text: string;
}
