import * as cheerio from "cheerio";

export type Field = { name: string; value: string };

export interface ParsedForm {
  action: string;
  method: string;
  multipart: boolean;
  fields: Field[];
}

export function load(html: string) {
  return cheerio.load(html);
}

/**
 * Parse a form into the list of name/value pairs a browser would submit
 * (minus submit buttons, which callers add explicitly). Handles inputs, selects,
 * textareas, checkboxes and radios, and controls attached via the `form` attribute.
 */
export function parseForm(html: string, selector: string): ParsedForm {
  const $ = cheerio.load(html);
  const form = $(selector).first();
  if (form.length === 0) throw new Error(`form not found: ${selector}`);
  const id = form.attr("id");
  const controls = form.find("input,select,textarea").toArray();
  if (id) {
    for (const el of $(`input[form="${id}"],select[form="${id}"],textarea[form="${id}"]`).toArray()) controls.push(el);
  }
  const fields: Field[] = [];
  for (const el of controls) {
    const c = $(el);
    const name = c.attr("name");
    if (!name || c.is(":disabled")) continue;
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    const type = (c.attr("type") ?? "text").toLowerCase();
    if (tag === "input") {
      if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
      if ((type === "checkbox" || type === "radio") && c.attr("checked") === undefined) continue;
      fields.push({ name, value: c.attr("value") ?? (type === "checkbox" ? "on" : "") });
    } else if (tag === "textarea") {
      fields.push({ name, value: c.text().replace(/^\n/, "") });
    } else if (tag === "select") {
      const multiple = c.attr("multiple") !== undefined;
      const selected = c.find("option[selected]").toArray();
      const pick = selected.length > 0 ? selected : multiple ? [] : c.find("option").first().toArray();
      for (const o of pick) fields.push({ name, value: $(o).attr("value") ?? $(o).text() });
    }
  }
  return {
    action: form.attr("action") ?? "",
    method: (form.attr("method") ?? "get").toLowerCase(),
    multipart: (form.attr("enctype") ?? "").includes("multipart"),
    fields,
  };
}

/** Replace/insert values by name. Sets every existing occurrence (first wins for repeats) or appends. */
export function withValues(fields: Field[], overrides: Record<string, string | string[]>): Field[] {
  const out = fields.filter((f) => !(f.name in overrides));
  for (const [name, v] of Object.entries(overrides)) {
    for (const value of Array.isArray(v) ? v : [v]) out.push({ name, value });
  }
  return out;
}

export interface PageMessages {
  errors: string[];
  fieldErrors: string[];
  warnings: string[];
  success: string[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Validation/flash messages the IPT renders in its HTML pages. */
export function pageMessages(html: string): PageMessages {
  const $ = cheerio.load(html);
  const grab = (sel: string) =>
    [...new Set($(sel).toArray().map((e) => clean($(e).text())).filter((t) => t.length > 0))];
  return {
    errors: grab(".alert-danger"),
    fieldErrors: grab(".field-error"),
    warnings: grab(".alert-warning"),
    success: grab(".alert-success"),
  };
}
