import { IptClient, type PageResult } from "./ipt-client.ts";
import { load, pageMessages, parseForm, withValues, type Field } from "./html.ts";
import { parseMappingPage, parseOverview, parseReport, type MappingPage, type PublicationReport, type ResourceStatus } from "./overview.ts";

export type ResourceType = "occurrence" | "checklist" | "samplingevent" | "materialentity" | "metadata" | "other";

export interface OpResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Path the IPT redirected to on success. */
  next?: string;
}

export interface ValidationReport {
  ready: boolean;
  problems: string[];
  warnings: string[];
  status: ResourceStatus;
}

export interface Agent {
  firstName?: string;
  lastName?: string;
  salutation?: string;
  organisation?: string;
  position?: string;
  address?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  /** Country as the IPT expects it (ISO 3166-1 alpha-2 code, e.g. "ES"). */
  country?: string;
  phone?: string;
  email?: string;
  homepage?: string;
  /** e.g. "https://orcid.org/" + identifier. */
  userIdDirectory?: string;
  userId?: string;
  /** Only for associated parties. */
  role?: string;
}

export type AgentList = "contacts" | "creators" | "metadataProviders" | "associatedParties";

export interface BasicMetadata {
  title?: string;
  description?: string;
  /** IPT license key: cczero | ccby | ccbync (see list in the basic metadata page). */
  license?: string;
  language?: string;
  metadataLanguage?: string;
  updateFrequency?: string;
  coreType?: ResourceType;
  subtype?: "" | "specimen" | "observation";
}

const SHORTNAME = /^[A-Za-z0-9_.-]+$/;

export function assertShortname(s: string): void {
  if (!SHORTNAME.test(s)) throw new Error(`invalid resource shortname: ${JSON.stringify(s)} (letters, digits, _ . - only)`);
}

const q = (s: string) => encodeURIComponent(s);

export function resultOf(res: PageResult): OpResult {
  const m = res.html ? pageMessages(res.html) : { errors: [], fieldErrors: [], warnings: [] };
  const accepted = res.status >= 300 && res.status < 400;
  return {
    ok: accepted,
    errors: accepted ? [] : [...m.errors, ...m.fieldErrors, ...(m.errors.length + m.fieldErrors.length === 0 ? [`IPT answered HTTP ${res.status}`] : [])],
    warnings: m.warnings,
    ...(res.redirectedTo ? { next: res.redirectedTo } : {}),
  };
}

/** High-level operations of the IPT manager UI, expressed as the same form posts a browser would send. */
export class IptManager {
  constructor(readonly client: IptClient) {}

  // ---- resource lifecycle ----

  /** Create an empty resource, or import an existing Darwin Core Archive (.zip) as its starting point. */
  async createResource(shortname: string, type: ResourceType, dwcaPath?: string): Promise<OpResult> {
    assertShortname(shortname);
    const res = await this.client.postMultipart(
      "/manage/create.do",
      [
        { name: "shortname", value: shortname },
        { name: "resourceType", value: type },
        ...(dwcaPath ? [{ name: "importDwca", value: "true" }] : []),
      ],
      dwcaPath ? [{ name: "file", path: dwcaPath }] : [],
    );
    return resultOf(res);
  }

  /** Replace the resource's EML with an uploaded EML file (optionally validating it first). */
  async replaceEml(shortname: string, emlPath: string, validate = true): Promise<OpResult> {
    assertShortname(shortname);
    const res = await this.client.postMultipart(
      "/manage/replace-eml.do",
      [
        { name: "r", value: shortname },
        { name: "validateEml", value: String(validate) },
        { name: "emlReplace", value: "Replace" },
      ],
      [{ name: "emlFile", path: emlPath }],
    );
    const r = resultOf(res);
    if (!r.ok) return r;
    // The IPT reports EML problems as messages on the overview it redirects to.
    const after = await this.client.getHtml(res.redirectedTo ?? `/manage/resource.do?r=${q(shortname)}`);
    const m = pageMessages(after.html);
    const errors = m.errors.filter((e) => /eml|xml|invalid|schema|failed/i.test(e));
    return { ...r, ok: errors.length === 0, errors, warnings: [...r.warnings, ...m.warnings] };
  }

  // ---- publication settings ----

  /** Pages holding per-resource publication options. */
  static readonly SETTINGS_PAGES = ["auto-publish", "publication-settings"] as const;

  async getSettings(shortname: string, page: (typeof IptManager.SETTINGS_PAGES)[number]): Promise<Field[]> {
    assertShortname(shortname);
    const res = await this.client.getHtml(`/manage/${page}.do?r=${q(shortname)}`);
    if (res.status !== 200) throw new Error(`cannot open ${page} (HTTP ${res.status})`);
    return parseForm(res.html, `form[action^='${page}']`).fields;
  }

  async setSettings(shortname: string, page: (typeof IptManager.SETTINGS_PAGES)[number], values: Record<string, string>): Promise<OpResult> {
    const fields = await this.getSettings(shortname, page);
    const known = new Set(fields.map((f) => f.name));
    const unknown = Object.keys(values).filter((k) => !known.has(k));
    if (unknown.length) return { ok: false, errors: [`unknown field(s) for ${page}: ${unknown.join(", ")}; valid: ${[...known].join(", ")}`], warnings: [] };
    return resultOf(await this.client.postForm(`/manage/${page}.do`, withValues(fields, { ...values, save: "Save" })));
  }

  // ---- metadata (any section) ----

  /** Load a metadata section form, apply overrides and save it, exactly like the browser would. */
  async saveMetadataSection(shortname: string, section: string, overrides: Record<string, string | string[]>, mutate?: (f: Field[]) => Field[], verify = false): Promise<OpResult> {
    assertShortname(shortname);
    const page = await this.client.getHtml(`/manage/metadata-${q(section)}.do?r=${q(shortname)}`);
    if (page.status !== 200) return { ok: false, errors: [`cannot open metadata section "${section}" (HTTP ${page.status})`], warnings: [] };
    const form = parseForm(page.html, `form[action^="metadata-${section}"]`);
    // `mutate` prunes the parsed form first; overrides are then applied on top.
    const base = mutate ? mutate(form.fields) : form.fields;
    const fields = withValues(base, { ...overrides, save: "Save" });
    const result = resultOf(await this.client.postForm(`/manage/${form.action}`, fields));
    if (!result.ok || !verify) return result;
    // The IPT silently drops parameters it does not know: read the section back and check that
    // every requested value was really stored.
    const after = await this.getMetadataForm(shortname, section);
    const norm = (v: string) => v.replace(/\s+/g, " ").trim();
    const missing = Object.entries(overrides).filter(([name, v]) => {
      const want = (Array.isArray(v) ? v : [v]).map(norm);
      const got = after.filter((f) => f.name === name).map((f) => norm(f.value));
      return !want.every((w) => got.includes(w));
    });
    if (missing.length === 0) return result;
    return {
      ...result,
      ok: false,
      errors: [
        `the IPT did not store: ${missing.map(([n]) => n).join(", ")} (unknown field name or value rejected). Fields of this section: ${after.map((f) => f.name).join(", ")}`,
      ],
    };
  }

  async setBasicMetadata(shortname: string, m: BasicMetadata): Promise<OpResult> {
    const overrides: Record<string, string> = {};
    if (m.title !== undefined) overrides["eml.title"] = m.title;
    if (m.description !== undefined) overrides["eml.description"] = m.description;
    if (m.language !== undefined) overrides["eml.language"] = m.language;
    if (m.metadataLanguage !== undefined) overrides["eml.metadataLanguage"] = m.metadataLanguage;
    if (m.updateFrequency !== undefined) overrides["eml.updateFrequency"] = m.updateFrequency;
    if (m.coreType !== undefined) overrides["resource.coreType"] = m.coreType;
    if (m.subtype !== undefined) overrides["resource.subtype"] = m.subtype;
    if (m.license !== undefined) {
      // The browser copies the license text into eml.intellectualRights via JS; do the same.
      const page = await this.client.getHtml(`/manage/metadata-basic.do?r=${q(shortname)}`);
      const $ = load(page.html);
      const text = $(`input[type="text"][id="${m.license}"]`).first().attr("value");
      if (!text) throw new Error(`unknown license key "${m.license}" (expected one of: ${this.licenseKeys($)})`);
      overrides["eml.intellectualRights.license"] = m.license;
      overrides["eml.intellectualRights"] = text;
    }
    return this.saveMetadataSection(shortname, "basic", overrides);
  }

  private licenseKeys($: ReturnType<typeof load>): string {
    return $('select[name="eml.intellectualRights.license"] option').toArray().map((o) => $(o).attr("value")).filter(Boolean).join(", ");
  }

  /**
   * Replace agent lists. The IPT validates the whole "contacts" page on save (at least one contact
   * and one creator), so all lists are posted together; lists not given keep their current rows.
   */
  async setAgents(shortname: string, lists: Partial<Record<AgentList, Agent[]>>): Promise<OpResult> {
    const o: Record<string, string> = {};
    for (const [list, agents] of Object.entries(lists) as Array<[AgentList, Agent[]]>) {
      agents.forEach((a, i) => {
        const p = `eml.${list}[${i}]`;
        const set = (k: string, v: string | undefined) => {
          if (v !== undefined && v !== "") o[`${p}.${k}`] = v;
        };
        set("firstName", a.firstName);
        set("lastName", a.lastName);
        set("salutation", a.salutation);
        set("organisation", a.organisation);
        set("position[0]", a.position);
        set("address.address[0]", a.address);
        set("address.city", a.city);
        set("address.province", a.province);
        set("address.postalCode", a.postalCode);
        set("address.country", a.country);
        set("phone[0]", a.phone);
        set("email[0]", a.email);
        set("homepage[0]", a.homepage);
        set("userIds[0].directory", a.userIdDirectory);
        set("userIds[0].identifier", a.userId);
        if (list === "associatedParties") set("role", a.role);
      });
    }
    // Only indexed agent rows are meaningful: the page also carries empty "eml.contact.*" prototype
    // inputs and unnamed templates that would overwrite the real rows if posted.
    const replaced = Object.keys(lists);
    const keep = (fs: Field[]) =>
      fs.filter(
        (f) =>
          f.name === "r" ||
          f.name === "metadata-section" ||
          (/^eml\.(contacts|creators|metadataProviders|associatedParties)\[/.test(f.name) && !replaced.some((l) => f.name.startsWith(`eml.${l}[`))),
      );
    return this.saveMetadataSection(shortname, "contacts", o, keep);
  }

  // ---- overview / status ----

  async getStatus(shortname: string): Promise<ResourceStatus> {
    assertShortname(shortname);
    const page = await this.client.getHtml(`/manage/resource.do?r=${q(shortname)}`);
    if (page.status === 404 || page.status === 401) throw new Error(`resource "${shortname}" not found or not manageable (HTTP ${page.status})`);
    const st = parseOverview(shortname, page.html);
    st.publishing = /\/manage\/locked\.do/.test(page.path);
    return st;
  }

  /** Extension row types available for mapping on this resource: [{rowType, label}]. */
  async listExtensions(shortname: string): Promise<Array<{ rowType: string; label: string }>> {
    const page = await this.client.getHtml(`/manage/resource.do?r=${q(shortname)}`);
    const $ = load(page.html);
    return $("#addMappingForm select[name='id'] option")
      .toArray()
      .map((o) => ({ rowType: $(o).attr("value") ?? "", label: $(o).text().replace(/\s+/g, " ").trim() }))
      .filter((o) => o.rowType !== "");
  }

  // ---- sources ----

  async addSourceFile(shortname: string, path: string, name?: string): Promise<OpResult & { source?: string }> {
    assertShortname(shortname);
    const res = await this.client.postMultipart(
      "/manage/addsource.do",
      [
        { name: "r", value: shortname },
        { name: "validate", value: "false" },
        { name: "sourceType", value: "source-file" },
        ...(name ? [{ name: "sourceName", value: name }] : []),
      ],
      [{ name: "file", path }],
    );
    return this.withSourceName(resultOf(res), res);
  }

  async addSourceUrl(shortname: string, url: string, name: string): Promise<OpResult & { source?: string }> {
    assertShortname(shortname);
    const res = await this.client.postMultipart("/manage/addsource.do", [
      { name: "r", value: shortname },
      { name: "validate", value: "false" },
      { name: "sourceType", value: "source-url" },
      { name: "sourceName", value: name },
      { name: "url", value: url },
    ]);
    return this.withSourceName(resultOf(res), res);
  }

  /**
   * Add a database (SQL) source. The IPT creates it as an unconfigured MySQL source; complete it
   * with {@link configureSource} passing `fields` (host, database, credentials, SQL).
   */
  async addSourceSql(shortname: string, name: string): Promise<OpResult & { source?: string }> {
    assertShortname(shortname);
    const res = await this.client.postMultipart("/manage/addsource.do", [
      { name: "r", value: shortname },
      { name: "validate", value: "false" },
      { name: "sourceType", value: "source-sql" },
      { name: "sourceName", value: name },
    ]);
    return this.withSourceName(resultOf(res), res);
  }

  private withSourceName(r: OpResult, res: PageResult): OpResult & { source?: string } {
    const id = res.redirectedTo ? new URLSearchParams(res.redirectedTo.split("?")[1] ?? "").get("id") : null;
    return id ? { ...r, source: id } : r;
  }

  /** Change how a file source is parsed, and/or re-analyse it (row/column counts, readability). */
  async configureSource(
    shortname: string,
    source: string,
    opts: { delimiter?: string; enclosedBy?: string; headerLines?: number; encoding?: string; dateFormat?: string; multiValueDelimiter?: string; analyze?: boolean; fields?: Record<string, string> } = {},
  ): Promise<OpResult> {
    assertShortname(shortname);
    const page = await this.client.getHtml(`/manage/source.do?r=${q(shortname)}&id=${q(source)}`);
    if (page.status !== 200) return { ok: false, errors: [`source "${source}" not found (HTTP ${page.status})`], warnings: [] };
    const form = parseForm(page.html, "form[action='source.do']");
    // File sources call these fields fileSource.*, URL sources source.*. The form never shows the stored value, so
    // posting them back empty would wipe what the IPT detected on upload: only send them when asked to.
    const sep = form.fields.find((f) => /^(file)?[sS]ource\.fieldsTerminatedByEscaped$/.test(f.name))?.name ?? "fileSource.fieldsTerminatedByEscaped";
    const quote = form.fields.find((f) => /^(file)?[sS]ource\.fieldsEnclosedByEscaped$/.test(f.name))?.name ?? "fileSource.fieldsEnclosedByEscaped";
    const o: Record<string, string> = {};
    if (opts.delimiter !== undefined) o[sep] = opts.delimiter;
    if (opts.enclosedBy !== undefined) o[quote] = opts.enclosedBy;
    if (opts.headerLines !== undefined) o["source.ignoreHeaderLines"] = String(opts.headerLines);
    if (opts.encoding !== undefined) o["source.encoding"] = opts.encoding;
    if (opts.dateFormat !== undefined) o["source.dateFormat"] = opts.dateFormat;
    if (opts.multiValueDelimiter !== undefined) o["source.multiValueFieldsDelimitedBy"] = opts.multiValueDelimiter;
    Object.assign(o, opts.fields ?? {});
    const wantsDelimiter = opts.delimiter !== undefined;
    // A delimiter can only be verified through analysis, so it always analyses.
    o[opts.analyze === false && !wantsDelimiter ? "save" : "analyze"] = opts.analyze === false && !wantsDelimiter ? "Save" : "Analyse";
    const result = resultOf(await this.client.postForm("/manage/source.do", withValues(form.fields, o).filter((f) => ![sep, quote].includes(f.name) || f.name in o)));
    if (!result.ok) return result;
    const warnings = [...result.warnings];
    if (opts.enclosedBy !== undefined) warnings.push("the quote character cannot be verified: IPT 3.3.0 may ignore it (see ipt_add_source: files are auto-detected on upload)");
    if (wantsDelimiter) {
      // IPT 3.3.0 silently drops the delimiter field of this form: check that the file is really read with it.
      const want = opts.delimiter === "\\t" ? "\t" : opts.delimiter!;
      const head = (await this.client.getPrefix(`/manage/raw-source.do?r=${q(shortname)}&id=${q(source)}`, 64 * 1024)).toString("utf8");
      const skip = opts.headerLines ?? 0;
      const firstLine = head.split(/\r?\n/)[skip] ?? "";
      const expected = firstLine.split(want).length;
      const actual = (await this.getStatus(shortname)).sources.find((s) => s.name === source)?.columns;
      if (actual !== expected) {
        return {
          ok: false,
          errors: [
            `the IPT ignored the requested delimiter ${JSON.stringify(opts.delimiter)}: it reads ${actual ?? "?"} column(s) but the file has ${expected} with that delimiter. IPT 3.3.0 detects the delimiter when the file is uploaded and does not apply changes made afterwards; re-upload the file using tab, comma, semicolon or pipe separators.`,
          ],
          warnings,
        };
      }
    }
    return { ...result, warnings };
  }

  async deleteSource(shortname: string, source: string): Promise<OpResult> {
    assertShortname(shortname);
    const res = await this.client.getHtml(`/manage/delete-source.do?r=${q(shortname)}&id=${q(source)}`);
    return { ok: res.status === 200, errors: res.status === 200 ? [] : [`delete-source answered HTTP ${res.status}`], warnings: [] };
  }

  /** First rows of a source as the IPT parsed them (columns + sample rows). */
  async peekSource(shortname: string, source: string): Promise<{ columns: string[]; rows: string[][] }> {
    const page = await this.client.getHtml(`/manage/peek.do?r=${q(shortname)}&id=${q(source)}`);
    const $ = load(page.html);
    const columns = $("table thead th").toArray().map((t) => $(t).text().trim());
    const rows = $("table tbody tr").toArray().map((tr) => $(tr).find("td").toArray().map((td) => $(td).text().trim()));
    return { columns, rows };
  }

  // ---- mappings ----

  /**
   * Add a mapping of a source to an extension row type (Occurrence, Taxon, Event, …).
   * The IPT automaps columns by header name when the mapping is created.
   * Refuses a second mapping of the same row type unless allowDuplicate (it multiplies published records).
   */
  async addMapping(shortname: string, rowType: string, source: string, allowDuplicate = false): Promise<OpResult & { mid?: number; automap?: string }> {
    assertShortname(shortname);
    const status = await this.getStatus(shortname);
    if (!allowDuplicate && status.mappings.some((m) => m.rowType === rowType)) {
      return { ok: false, errors: [`a mapping for ${rowType} already exists; a second one would publish its records again (set allowDuplicate to force)`], warnings: [] };
    }
    if (!status.sources.some((s) => s.name === source)) {
      return { ok: false, errors: [`unknown source "${source}"; available: ${status.sources.map((s) => s.name).join(", ") || "none"}`], warnings: [] };
    }
    const step1 = await this.client.postForm("/manage/mapping.do", [
      { name: "r", value: shortname },
      { name: "id", value: rowType },
    ]);
    if (!step1.redirectedTo) return resultOf(step1);
    const mid = Number(new URLSearchParams(step1.redirectedTo.split("?")[1] ?? "").get("mid") ?? 0);
    const page = await this.client.getHtml(step1.redirectedTo);
    const form = parseForm(page.html, "form[action='mapping.do']");
    const saved = await this.client.postForm("/manage/mapping.do", withValues(form.fields, { source, save: "Save" }));
    const r = resultOf(saved);
    if (!r.ok) return r;
    const after = await this.client.getHtml(saved.redirectedTo ?? step1.redirectedTo);
    const automap = pageMessages(after.html).success.find((m) => /automapped/i.test(m));
    return { ...r, mid, ...(automap ? { automap } : {}) };
  }

  async getMapping(shortname: string, rowType: string, mid = 0): Promise<MappingPage> {
    assertShortname(shortname);
    const page = await this.client.getHtml(`/manage/mapping.do?r=${q(shortname)}&id=${q(rowType)}&mid=${mid}`);
    if (page.status !== 200) throw new Error(`mapping not found (HTTP ${page.status})`);
    return parseMappingPage(page.html);
  }

  /**
   * Set term→column assignments and/or default values on an existing mapping.
   * `columns` maps a term (URI, "dwc:name" or bare name) to a column header (or null to unmap);
   * `defaults` maps a term to a constant value.
   */
  async setMapping(
    shortname: string,
    rowType: string,
    mid: number,
    change: { columns?: Record<string, string | null>; defaults?: Record<string, string>; idColumn?: string },
  ): Promise<OpResult> {
    assertShortname(shortname);
    const path = `/manage/mapping.do?r=${q(shortname)}&id=${q(rowType)}&mid=${mid}`;
    const page = await this.client.getHtml(path);
    if (page.status !== 200) return { ok: false, errors: [`mapping not found (HTTP ${page.status})`], warnings: [] };
    const parsed = parseMappingPage(page.html);
    const form = parseForm(page.html, "form#mappingForm, form[action='mapping.do']");
    const colIndex = (name: string): number => {
      const i = parsed.columns.findIndex((c) => c?.toLowerCase() === name.toLowerCase());
      if (i < 0) throw new Error(`unknown column "${name}"; columns: ${parsed.columns.join(", ")}`);
      return i;
    };
    const findRow = (term: string) => {
      const t = term.toLowerCase();
      const hit = parsed.fields.find(
        (f) => f.uri?.toLowerCase() === t || f.qualName.toLowerCase() === t || f.qualName.toLowerCase().endsWith(`:${t}`),
      );
      if (!hit) throw new Error(`unknown term "${term}" for this extension`);
      return hit;
    };
    const o: Record<string, string> = { save: "Save" };
    for (const [term, col] of Object.entries(change.columns ?? {})) o[findRow(term).indexParam] = col === null ? "" : String(colIndex(col));
    for (const [term, v] of Object.entries(change.defaults ?? {})) {
      const row = findRow(term);
      if (!row.defaultParam) throw new Error(`term "${term}" has no default value input`);
      o[row.defaultParam] = v;
    }
    if (change.idColumn !== undefined) o["mapping.idColumn"] = String(colIndex(change.idColumn));
    return resultOf(await this.client.postForm("/manage/mapping.do", withValues(form.fields, o)));
  }

  async deleteMapping(shortname: string, rowType: string, mid = 0): Promise<OpResult> {
    assertShortname(shortname);
    const res = await this.client.getHtml(`/manage/delete-mapping.do?r=${q(shortname)}&id=${q(rowType)}&mid=${mid}`);
    return { ok: res.status === 200, errors: res.status === 200 ? [] : [`delete-mapping answered HTTP ${res.status}`], warnings: [] };
  }

  // ---- publishing ----

  /**
   * Publish without pre-flight checks. The IPT happily publishes resources with invalid metadata
   * or without data (as a metadata-only version), so prefer {@link publish}.
   */
  async publishRaw(shortname: string, summary = ""): Promise<OpResult & { version?: string; finished?: boolean }> {
    assertShortname(shortname);
    const res = await this.client.postForm("/manage/publish.do", [
      { name: "r", value: shortname },
      { name: "summary", value: summary },
      { name: "publish", value: "Publish" },
    ]);
    const m = res.html ? pageMessages(res.html) : { errors: [], fieldErrors: [], warnings: [], success: [] };
    const line = m.success.find((x) => /Publishing version #/i.test(x));
    const version = line?.match(/#(\d+(?:\.\d+)*)/)?.[1];
    const finished = line ? /finished successfully/i.test(line) : undefined;
    return {
      ok: line !== undefined,
      errors: line ? [] : [...m.errors, ...(m.errors.length === 0 ? [`publish not started (HTTP ${res.status})`] : [])],
      warnings: m.warnings,
      ...(version ? { version } : {}),
      ...(finished !== undefined ? { finished } : {}),
    };
  }

  /**
   * Pre-flight check of everything the IPT would let through but should not be published:
   * invalid metadata, missing/unanalysed sources, missing mappings, unmapped required terms.
   */
  async validateResource(shortname: string, opts: { metadataOnly?: boolean } = {}): Promise<ValidationReport> {
    const st = await this.getStatus(shortname);
    const problems: string[] = [];
    const warnings: string[] = [];
    if (st.publishing) problems.push("a publication is already in progress");
    for (const p of st.metadataProblems) for (const msg of p.messages) problems.push(`metadata / ${p.section}: ${msg}`);
    if (st.metadataProblems.length === 0 && /\bInvalid\b/.test(st.metadata)) problems.push("metadata is reported invalid by the IPT");

    if (!opts.metadataOnly) {
      if (st.sources.length === 0) problems.push("no data sources: add a source or publish metadata-only");
      for (const s of st.sources) if (!s.rows) problems.push(`source "${s.name}" has no analysed rows (re-run configure_source/analyze)`);
      if (st.mappings.length === 0) problems.push("no mappings: map a source to an extension (e.g. Occurrence)");
      const seen = new Set<string>();
      for (const mp of st.mappings) {
        if (seen.has(mp.rowType)) warnings.push(`more than one mapping for ${mp.rowType}: records will be published once per mapping`);
        seen.add(mp.rowType);
        const page = await this.getMapping(shortname, mp.rowType, mp.mid);
        if (page.idColumn === undefined) problems.push(`mapping ${mp.rowType} #${mp.mid}: no ID column selected`);
        for (const f of page.fields) {
          if (f.required && f.index === undefined && f.defaultValue === "") problems.push(`mapping ${mp.rowType} #${mp.mid}: required term ${f.qualName} is not mapped`);
        }
      }
    }
    return { ready: problems.length === 0, problems, warnings, status: st };
  }

  /**
   * Validate, then publish. Refuses when the pre-flight finds problems (unless force).
   * Does not wait for completion: use {@link waitForPublication}.
   */
  async publish(shortname: string, summary = "", opts: { metadataOnly?: boolean; force?: boolean } = {}): Promise<OpResult & { version?: string; finished?: boolean; problems?: string[] }> {
    if (!opts.force) {
      const v = await this.validateResource(shortname, opts.metadataOnly === undefined ? {} : { metadataOnly: opts.metadataOnly });
      if (!v.ready) return { ok: false, errors: ["not ready to publish"], warnings: v.warnings, problems: v.problems };
    }
    return this.publishRaw(shortname, summary);
  }

  async getPublicationReport(shortname: string): Promise<PublicationReport> {
    assertShortname(shortname);
    const res = await this.client.getHtml(`/manage/report.do?r=${q(shortname)}`);
    return parseReport(res.html);
  }

  /**
   * Poll until the publication finishes (or the timeout elapses). Pass the version being
   * published to also accept "that version is now the current one" (fast, synchronous publications
   * leave no report behind).
   */
  async waitForPublication(shortname: string, timeoutMs = 10 * 60_000, intervalMs = 1500, version?: string): Promise<PublicationReport> {
    const end = Date.now() + timeoutMs;
    let last: PublicationReport = { state: "unknown" };
    while (Date.now() < end) {
      last = await this.getPublicationReport(shortname);
      if (last.state === "completed" || last.state === "failed") return last;
      if (last.state === "unknown" && version && (await this.getStatus(shortname)).lastPublishedVersion === version) {
        return { state: "completed", message: `version ${version} is published` };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { state: "running", message: "timeout waiting for publication" };
  }

  async publicationLog(shortname: string): Promise<string> {
    const res = await this.client.getHtml(`/publicationlog.do?r=${q(shortname)}`);
    return res.html;
  }

  async setVisibility(shortname: string, visibility: "public" | "private"): Promise<OpResult> {
    assertShortname(shortname);
    const action = visibility === "public" ? "makePublic" : "makePrivate";
    // The UI's own forms: make-private carries unpublish=Change; make-public an (empty = no schedule) makePublicDateTime.
    const res = await this.client.postForm(`/manage/resource-${action}.do`, [
      { name: "r", value: shortname },
      ...(visibility === "private" ? [{ name: "unpublish", value: "Change" }] : [{ name: "makePublicDateTime", value: "" }]),
    ]);
    const result = resultOf(res);
    if (!result.ok || !res.redirectedTo) return result;
    // The IPT refuses invalid transitions (e.g. asking for the state it already has) with a warning on the page it redirects to.
    const refusal = pageMessages((await this.client.getHtml(res.redirectedTo)).html).warnings.find((w) => /invalid change/i.test(w));
    return refusal ? { ok: false, errors: [refusal], warnings: [] } : result;
  }

  async deleteResource(shortname: string): Promise<OpResult> {
    assertShortname(shortname);
    // "IPT only": never touches the GBIF registry, even for a registered resource.
    return resultOf(await this.client.postForm("/manage/resource-deleteFromIpt.do", [{ name: "r", value: shortname }, { name: "deleteFlag", value: "IPT only (orphan)" }]));
  }

  // ---- structured metadata sections ----

  /**
   * Save a section after removing every form field under the given list prefixes (e.g.
   * "eml.temporalCoverages[") and any non-EML template noise, then applying `values`.
   * This gives "replace the list" semantics for repeatable items.
   */
  private async saveList(shortname: string, section: string, prefixes: string[], values: Record<string, string>): Promise<OpResult> {
    const keep = (fs: Field[]) =>
      fs.filter(
        (f) =>
          (f.name === "r" || f.name === "metadata-section" || /^(eml|resource)\./.test(f.name) || f.name === "globalCoverage") &&
          !prefixes.some((p) => f.name.startsWith(p)),
      );
    return this.saveMetadataSection(shortname, section, values, keep);
  }

  async setGeographicCoverage(
    shortname: string,
    coverages: Array<{ description?: string; minLatitude: number; maxLatitude: number; minLongitude: number; maxLongitude: number }>,
  ): Promise<OpResult> {
    const v: Record<string, string> = {};
    coverages.forEach((c, i) => {
      if (c.minLatitude > c.maxLatitude) throw new Error(`coverage ${i}: minLatitude > maxLatitude`);
      if (c.minLongitude > c.maxLongitude) throw new Error(`coverage ${i}: minLongitude > maxLongitude (use two boxes across the antimeridian)`);
      const p = `eml.geospatialCoverages[${i}]`;
      v[`${p}.boundingCoordinates.min.latitude`] = String(c.minLatitude);
      v[`${p}.boundingCoordinates.max.latitude`] = String(c.maxLatitude);
      v[`${p}.boundingCoordinates.min.longitude`] = String(c.minLongitude);
      v[`${p}.boundingCoordinates.max.longitude`] = String(c.maxLongitude);
      if (c.description) v[`${p}.description`] = c.description;
    });
    return this.saveList(shortname, "geocoverage", ["eml.geospatialCoverages["], v);
  }

  async setTaxonomicCoverage(
    shortname: string,
    coverages: Array<{ description?: string; taxa: Array<{ scientificName: string; commonName?: string; rank?: string }> }>,
  ): Promise<OpResult> {
    const v: Record<string, string> = {};
    coverages.forEach((c, i) => {
      const p = `eml.taxonomicCoverages[${i}]`;
      if (c.description) v[`${p}.description`] = c.description;
      c.taxa.forEach((t, j) => {
        v[`${p}.taxonKeywords[${j}].scientificName`] = t.scientificName;
        if (t.commonName) v[`${p}.taxonKeywords[${j}].commonName`] = t.commonName;
        if (t.rank) v[`${p}.taxonKeywords[${j}].rank`] = t.rank;
      });
    });
    return this.saveList(shortname, "taxcoverage", ["eml.taxonomicCoverages["], v);
  }

  /** Dates are ISO yyyy-mm-dd. A single date leaves endDate empty. */
  async setTemporalCoverage(shortname: string, coverages: Array<{ startDate: string; endDate?: string }>): Promise<OpResult> {
    const v: Record<string, string> = {};
    coverages.forEach((c, i) => {
      for (const d of [c.startDate, c.endDate]) if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`coverage ${i}: date "${d}" is not yyyy-mm-dd`);
      if (c.endDate && c.endDate < c.startDate) throw new Error(`coverage ${i}: endDate before startDate`);
      v[`eml.temporalCoverages[${i}].startDate`] = c.startDate;
      if (c.endDate) v[`eml.temporalCoverages[${i}].endDate`] = c.endDate;
    });
    return this.saveList(shortname, "tempcoverage", ["eml.temporalCoverages["], v);
  }

  async setKeywords(shortname: string, groups: Array<{ thesaurus?: string; keywords: string[] }>): Promise<OpResult> {
    const v: Record<string, string> = {};
    groups.forEach((g, i) => {
      v[`eml.keywords[${i}].keywordThesaurus`] = g.thesaurus ?? "n/a";
      v[`eml.keywords[${i}].keywordsString`] = g.keywords.join(", ");
    });
    return this.saveList(shortname, "keywords", ["eml.keywords["], v);
  }

  async setMethods(shortname: string, m: { studyExtent?: string; sampleDescription?: string; qualityControl?: string; steps?: string[] }): Promise<OpResult> {
    const v: Record<string, string> = {};
    if (m.studyExtent !== undefined) v["eml.studyExtent"] = m.studyExtent;
    if (m.sampleDescription !== undefined) v["eml.sampleDescription"] = m.sampleDescription;
    if (m.qualityControl !== undefined) v["eml.qualityControl"] = m.qualityControl;
    (m.steps ?? []).forEach((st, i) => (v[`eml.methodSteps[${i}]`] = st));
    return this.saveList(shortname, "methods", m.steps ? ["eml.methodSteps["] : [], v);
  }

  /** Current form fields of any metadata section (names the IPT accepts, with current values). */
  async getMetadataForm(shortname: string, section: string): Promise<Field[]> {
    assertShortname(shortname);
    const page = await this.client.getHtml(`/manage/metadata-${q(section)}.do?r=${q(shortname)}`);
    if (page.status !== 200) throw new Error(`cannot open metadata section "${section}" (HTTP ${page.status})`);
    return parseForm(page.html, `form[action^="metadata-${section}"]`).fields.filter((f) => /^(eml|resource)\./.test(f.name) || f.name === "globalCoverage");
  }

  /** The draft EML the IPT currently holds for the resource (what managers download from the overview). */
  async getDraftEml(shortname: string): Promise<string> {
    assertShortname(shortname);
    return (await this.client.getHtml(`/manage/eml.do?r=${q(shortname)}`)).html;
  }
}
