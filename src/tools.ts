import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Config, InstanceConfig } from "./config.ts";
import { IptClient, summarizeEml } from "./ipt-client.ts";
import { IptManager, type OpResult } from "./manager.ts";
import { assertReadablePath } from "./paths.ts";
import { Redactor } from "./redact.ts";
import { validateTsvFile } from "./validate-tsv.ts";

export { loadConfig } from "./config.ts";

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

/** Everything returned to the model goes through this: credentials never leave the server. */
let redactor = new Redactor([]);
export const setSecrets = (secrets: Array<string | undefined>) => (redactor = new Redactor(secrets));
const render = (v: unknown): string => (typeof v === "string" ? redactor.str(v) : JSON.stringify(redactor.value(v instanceof Error ? { error: v.message } : v), null, 2));
const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: render(v) }] });
const fail = (v: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: v instanceof Error ? redactor.str(v.message) : render(v) }] });

const shortname = z.string().regex(/^[A-Za-z0-9_.-]+$/, "resource shortname (letters, digits, _ . -)").describe("Resource shortname");
const confirm = z.boolean().default(false).describe("Must be true to actually perform this action");

const RESOURCE_TYPES = ["occurrence", "checklist", "samplingevent", "materialentity", "metadata", "other"] as const;

const agent = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  organisation: z.string().optional(),
  position: z.string().optional(),
  salutation: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  homepage: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional().describe("ISO 3166-1 alpha-2 code, e.g. ES"),
  userIdDirectory: z.string().optional().describe('e.g. "https://orcid.org/"'),
  userId: z.string().optional().describe("e.g. the ORCID iD digits"),
  role: z.string().optional().describe("Only for associatedParties, e.g. editor, originator"),
});

/** Lazily-authenticated manager session shared by all tools. */
export class Session {
  readonly publicClient: IptClient;
  private mgr?: IptManager;
  private login?: Promise<IptManager>;

  constructor(readonly cfg: InstanceConfig) {
    this.publicClient = new IptClient(cfg.url);
  }

  manager(): Promise<IptManager> {
    if (this.mgr) return Promise.resolve(this.mgr);
    this.login ??= (async () => {
      if (!this.cfg.email || !this.cfg.password) throw new Error(`No credentials configured for the IPT instance "${this.cfg.name}": set its email and password (IPT_EMAIL/IPT_PASSWORD, or IPT_INSTANCES) to use manager tools.`);
      const client = new IptClient(this.cfg.url);
      await client.login({ email: this.cfg.email, password: this.cfg.password });
      return (this.mgr = new IptManager(client));
    })().catch((e) => {
      this.login = undefined;
      throw e;
    });
    return this.login;
  }
}

const opText = (r: OpResult): ToolResult => (r.ok ? text(r) : fail(r));

/** The configured IPTs; every tool call runs against one of them (`instance` argument, default: the first/default one). */
export class Registry {
  private sessions = new Map<string, Session>();
  private current = new AsyncLocalStorage<Session>();
  constructor(readonly cfg: Config) {
    for (const i of cfg.instances) this.sessions.set(i.name, new Session(i));
  }
  get multi(): boolean {
    return this.sessions.size > 1;
  }
  get(name?: string): Session {
    const s = this.sessions.get(name ?? this.cfg.default);
    if (!s) throw new Error(`unknown IPT instance "${name}"; configured: ${[...this.sessions.keys()].join(", ")}`);
    return s;
  }
  /** Run fn with `name` as the instance every session accessor resolves to. */
  run<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
    return this.current.run(this.get(name), fn);
  }
  get active(): Session {
    return this.current.getStore() ?? this.get();
  }
  list() {
    return [...this.sessions.values()].map(({ cfg: c }) => ({
      name: c.name,
      url: c.url.replace(/\/\/[^/@]*@/, "//"),
      default: c.name === this.cfg.default,
      credentials: Boolean(c.email && c.password),
      readonly: c.readonly,
    }));
  }
}

export function registerTools(server: McpServer, registry: Registry): void {
  setSecrets(registry.cfg.instances.flatMap((i) => [i.password, i.url.match(/\/\/[^/@:]+:([^/@]+)@/)?.[1]]));
  // Tool bodies use `session`: it always points at the instance chosen for the current call.
  const session = {
    manager: () => registry.active.manager(),
    get publicClient() {
      return registry.active.publicClient;
    },
  };
  const instanceArg = registry.multi
    ? { instance: z.string().optional().describe(`IPT to use: ${registry.cfg.instances.map((i) => i.name).join(" | ")} (default ${registry.cfg.default}; see ipt_list_instances)`) }
    : {};

  /** Register a tool that reads only. */
  const read = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<ToolResult>) =>
    server.tool(name, description, { ...shape, ...instanceArg }, (async ({ instance, ...a }: { instance?: string } & z.infer<z.ZodObject<S>>) => {
      try {
        return await registry.run(instance, () => fn(a as z.infer<z.ZodObject<S>>));
      } catch (e) {
        return fail(e);
      }
    }) as never);

  /** Register a tool that changes the IPT: blocked in read-only mode. */
  const write = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>, m: IptManager) => Promise<ToolResult>) =>
    server.tool(name, `[writes to the IPT] ${description}`, { ...shape, ...instanceArg }, (async ({ instance, ...a }: { instance?: string } & z.infer<z.ZodObject<S>>) => {
      try {
        return await registry.run(instance, async () => {
          const cfg = registry.active.cfg;
          if (cfg.readonly) return fail(`The IPT instance "${cfg.name}" is read-only: this tool is disabled for it.`);
          return fn(a as z.infer<z.ZodObject<S>>, await session.manager());
        });
      } catch (e) {
        return fail(e);
      }
    }) as never);

  const needConfirm = (what: string): ToolResult =>
    fail({ ok: false, needsConfirmation: true, ...(registry.multi ? { instance: registry.active.cfg.name, url: registry.active.cfg.url } : {}), message: `${what} Call again with confirm: true to proceed.` });

  // ---------------- public, read-only ----------------

  server.tool("ipt_list_instances", "The IPT servers this MCP can talk to (name, URL, default, whether it has credentials, read-only). Never shows credentials.", {}, (async () => text(registry.list())) as never);

  read("ipt_health", "IPT status (disk, registry/network flags). Public.", {}, async () => text(await session.publicClient.health()));

  read(
    "ipt_list_datasets",
    "List published datasets of the IPT (id, title, version, records, core, DwC-A/EML URLs). Public: private resources do not appear. `query` matches id and title; with searchMetadata it also looks in each dataset's abstract and keywords (\"datasets that mention plants\"). A records value of 0 means the IPT inventory reports no count, not necessarily an empty dataset.",
    {
      query: z.string().optional().describe("Case-insensitive text to look for"),
      searchMetadata: z.boolean().default(false).describe("Also search the EML abstract and keywords (fetches each dataset's EML)"),
      limit: z.number().int().min(1).max(200).default(25),
    },
    async ({ query, searchMetadata, limit }) => {
      const all = await session.publicClient.listDatasets();
      const q = query?.toLowerCase();
      if (!q) return text({ total: all.length, matched: all.length, datasets: all.slice(0, limit) });
      const matches: Array<(typeof all)[number] & { matchedIn: string }> = [];
      const queue = [...all];
      const worker = async () => {
        for (let d = queue.shift(); d; d = queue.shift()) {
          if (d.id.toLowerCase().includes(q) || d.title.toLowerCase().includes(q)) {
            matches.push({ ...d, matchedIn: "id/title" });
          } else if (searchMetadata) {
            try {
              const s = summarizeEml(await session.publicClient.getEml(d.id));
              const where = s.abstract?.toLowerCase().includes(q) ? "abstract" : s.keywords.some((k) => k.toLowerCase().includes(q)) ? "keywords" : undefined;
              if (where) matches.push({ ...d, matchedIn: where });
            } catch {
              /* a dataset whose EML cannot be read simply does not match */
            }
          }
        }
      };
      await Promise.all(Array.from({ length: 5 }, worker));
      matches.sort((a, b) => a.id.localeCompare(b.id));
      return text({ total: all.length, matched: matches.length, datasets: matches.slice(0, limit) });
    },
  );

  read("ipt_get_metadata", "Fetch a published dataset's EML and return a summary (title, abstract, license, contact count).", { shortname }, async ({ shortname }) =>
    text(summarizeEml(await session.publicClient.getEml(shortname))),
  );

  read(
    "validate_tsv",
    "Validate a local Darwin Core text file BEFORE uploading it: column-count consistency (embedded newlines/tabs), UTF-8/mojibake, year/month/day and lat/long ranges, duplicate occurrenceID. Streams; safe for multi-GB files.",
    {
      path: z.string().describe("Absolute path of the file on the machine running this MCP server"),
      delimiter: z.string().default("\t"),
      idColumn: z.string().default("occurrenceID"),
      maxIssues: z.number().int().min(1).max(200).default(20),
    },
    async ({ path, delimiter, idColumn, maxIssues }) => text(await validateTsvFile(assertReadablePath(path, "data"), { delimiter, idColumn, maxIssues })),
  );

  // ---------------- manager: read ----------------

  read("ipt_list_managed_resources", "Resources the configured IPT user can manage (needs IPT_EMAIL/IPT_PASSWORD).", {}, async () => {
    const m = await session.manager();
    return text(await m.client.listManagedResources());
  });

  read("ipt_get_status", "Status of a resource: visibility, sources (rows/columns), mappings, metadata validity and problems, published/next version.", { shortname }, async ({ shortname }) => {
    const m = await session.manager();
    const { publication: _p, ...st } = await m.getStatus(shortname);
    return text(st);
  });

  read(
    "ipt_validate_resource",
    "Pre-flight check before publishing: invalid metadata (per section), missing/unanalysed sources, missing mappings, unmapped required terms. The IPT itself does NOT block these.",
    { shortname, metadataOnly: z.boolean().default(false).describe("Set when the resource intentionally has no data") },
    async ({ shortname, metadataOnly }) => {
      const m = await session.manager();
      const v = await m.validateResource(shortname, { metadataOnly });
      return text({ ready: v.ready, problems: v.problems, warnings: v.warnings });
    },
  );

  read("ipt_list_extensions", "Extension row types available for mapping on this resource.", { shortname }, async ({ shortname }) => text(await (await session.manager()).listExtensions(shortname)));

  read(
    "ipt_get_mapping",
    "Show a mapping: source columns, ID column, the term assignments (mapped terms and required unmapped terms unless all=true), the source columns that are not mapped to any term, and the required terms still unmapped.",
    { shortname, rowType: z.string().describe("Extension row type URI, e.g. http://rs.tdwg.org/dwc/terms/Occurrence"), mid: z.number().int().default(0), all: z.boolean().default(false) },
    async ({ shortname, rowType, mid, all }) => {
      const page = await (await session.manager()).getMapping(shortname, rowType, mid);
      const fields = page.fields
        .filter((f) => all || f.index !== undefined || f.defaultValue !== "" || f.required)
        .map((f) => ({ term: f.qualName, required: f.required, column: f.index !== undefined ? page.columns[f.index] : undefined, default: f.defaultValue || undefined }));
      const used = new Set<number>(page.fields.flatMap((f) => (f.index !== undefined ? [f.index] : [])));
      if (page.idColumn !== undefined) used.add(page.idColumn);
      return text({
        columns: page.columns,
        idColumn: page.idColumn !== undefined ? page.columns[page.idColumn] ?? page.idColumn : undefined,
        unmappedColumns: page.columns.filter((_, i) => !used.has(i)),
        unmappedRequiredTerms: page.fields.filter((f) => f.required && f.index === undefined && f.defaultValue === "").map((f) => f.qualName),
        fields,
      });
    },
  );

  read("ipt_peek_source", "First rows of a source as the IPT parsed them.", { shortname, source: z.string() }, async ({ shortname, source }) =>
    text(await (await session.manager()).peekSource(shortname, source)),
  );

  read(
    "ipt_get_publication_status",
    "State of the latest publication (running/completed/failed) and the tail of the publication log.",
    { shortname, logLines: z.number().int().min(0).max(200).default(20) },
    async ({ shortname, logLines }) => {
      const m = await session.manager();
      const report = await m.getPublicationReport(shortname);
      const log = logLines > 0 ? (await m.publicationLog(shortname)).split("\n").slice(-logLines).join("\n") : undefined;
      return text({ ...report, ...(log ? { log } : {}) });
    },
  );

  read("ipt_get_metadata_form", "Editable fields (names and current values) of a metadata section, to use with ipt_set_metadata_fields. Sections: basic, contacts, acknowledgements, geocoverage, taxcoverage, tempcoverage, additionalDescription, keywords, project, methods, citations, collections, physical, additional.", { shortname, section: z.string() }, async ({ shortname, section }) =>
    text(await (await session.manager()).getMetadataForm(shortname, section)),
  );

  read("ipt_get_draft_eml", "The draft EML the IPT currently holds for the resource.", { shortname }, async ({ shortname }) => text(await (await session.manager()).getDraftEml(shortname)));

  read(
    "ipt_get_datapackage_metadata",
    "The datapackage.json of a data package resource (Camtrap DP, ColDP, Frictionless), to edit it and send it back with ipt_replace_datapackage_metadata. `source` says whether it is the draft (ColDP) or the last published version (Camtrap DP: the IPT does not expose the draft as JSON). Editing the file in the IPT data directory does not work while the IPT runs (it is read only at startup and overwritten on every save).",
    { shortname },
    async ({ shortname }) => text(await (await session.manager()).getDatapackageMetadata(shortname)),
  );

  read("ipt_get_settings", "Publication options form (page: auto-publish | publication-settings).", { shortname, page: z.enum(IptManager.SETTINGS_PAGES) }, async ({ shortname, page }) =>
    text(await (await session.manager()).getSettings(shortname, page)),
  );

  // ---------------- manager: write ----------------

  write(
    "ipt_create_resource",
    "Create a resource, empty or importing a Darwin Core Archive or data package (.zip, e.g. a published Camtrap DP) from a local path. camtrap-dp / coldp need that data package schema installed in the IPT.",
    { shortname, type: z.enum([...RESOURCE_TYPES, "camtrap-dp", "coldp"]), dwcaPath: z.string().optional().describe("Local .zip DwC-A or data package to import") },
    async ({ shortname, type, dwcaPath }, m) => opText(await m.createResource(shortname, type, dwcaPath ? assertReadablePath(dwcaPath, "dwca") : undefined)),
  );

  write(
    "ipt_set_basic_metadata",
    "Set title, description, license (cczero | ccby | ccbync), language, update frequency, type. Omitted fields are left as they are.",
    {
      shortname,
      title: z.string().optional(),
      description: z.string().optional(),
      license: z.string().optional().describe("IPT license key: cczero, ccby or ccbync"),
      language: z.string().optional().describe("ISO 639-3, e.g. eng, spa"),
      metadataLanguage: z.string().optional(),
      updateFrequency: z.string().optional().describe("daily, weekly, monthly, annually, asNeeded, unknown, …"),
      coreType: z.enum(RESOURCE_TYPES).optional(),
    },
    async ({ shortname, ...meta }, m) => {
      const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
      return opText(await m.setBasicMetadata(shortname, clean));
    },
  );

  write(
    "ipt_set_contacts",
    "Replace agent lists. The IPT requires at least one contact and one creator; lists not given keep their current rows. Each agent needs a last name, an organisation or a position.",
    { shortname, contacts: z.array(agent).optional(), creators: z.array(agent).optional(), metadataProviders: z.array(agent).optional(), associatedParties: z.array(agent).optional() },
    async ({ shortname, ...lists }, m) => opText(await m.setAgents(shortname, Object.fromEntries(Object.entries(lists).filter(([, v]) => v !== undefined)))),
  );

  write(
    "ipt_set_coverage",
    "Replace geographic, taxonomic and/or temporal coverage (only the ones given).",
    {
      shortname,
      geographic: z.array(z.object({ description: z.string().optional(), minLatitude: z.number().min(-90).max(90), maxLatitude: z.number().min(-90).max(90), minLongitude: z.number().min(-180).max(180), maxLongitude: z.number().min(-180).max(180) })).optional(),
      taxonomic: z.array(z.object({ description: z.string().optional(), taxa: z.array(z.object({ scientificName: z.string(), commonName: z.string().optional(), rank: z.string().optional() })) })).optional(),
      temporal: z.array(z.object({ startDate: z.string().describe("yyyy-mm-dd"), endDate: z.string().optional().describe("yyyy-mm-dd; omit for a single date") })).optional(),
    },
    async ({ shortname, geographic, taxonomic, temporal }, m) => {
      const out: Record<string, OpResult> = {};
      if (geographic) out["geographic"] = await m.setGeographicCoverage(shortname, geographic);
      if (taxonomic) out["taxonomic"] = await m.setTaxonomicCoverage(shortname, taxonomic);
      if (temporal) out["temporal"] = await m.setTemporalCoverage(shortname, temporal);
      const ok = Object.values(out).every((r) => r.ok);
      return ok ? text({ ok, ...out }) : fail({ ok, ...out });
    },
  );

  write(
    "ipt_set_keywords_methods",
    "Replace keyword sets and/or methods (study extent, sampling, quality control, steps).",
    {
      shortname,
      keywords: z.array(z.object({ thesaurus: z.string().optional(), keywords: z.array(z.string()) })).optional(),
      methods: z.object({ studyExtent: z.string().optional(), sampleDescription: z.string().optional(), qualityControl: z.string().optional(), steps: z.array(z.string()).optional() }).optional(),
    },
    async ({ shortname, keywords, methods }, m) => {
      const out: Record<string, OpResult> = {};
      if (keywords) out["keywords"] = await m.setKeywords(shortname, keywords);
      if (methods) out["methods"] = await m.setMethods(shortname, Object.fromEntries(Object.entries(methods).filter(([, v]) => v !== undefined)));
      const ok = Object.values(out).every((r) => r.ok);
      return ok ? text({ ok, ...out }) : fail({ ok, ...out });
    },
  );

  write(
    "ipt_set_metadata_fields",
    "Save any metadata section by raw field names (get them with ipt_get_metadata_form). Repeatable items use indexed names such as eml.citation.citation or eml.physicalData[0].name.",
    { shortname, section: z.string(), fields: z.record(z.string()) },
    async ({ shortname, section, fields }, m) => opText(await m.saveMetadataSection(shortname, section, fields, undefined, true)),
  );

  write(
    "ipt_replace_eml",
    "Replace the resource's metadata with an EML file from a local path.",
    { shortname, path: z.string(), validate: z.boolean().default(true), confirm },
    async ({ shortname, path, validate, confirm }, m) => (confirm ? opText(await m.replaceEml(shortname, assertReadablePath(path, "eml"), validate)) : needConfirm("This overwrites the resource's current metadata.")),
  );

  write(
    "ipt_replace_datapackage_metadata",
    "Replace a data package resource's (Camtrap DP, ColDP, Frictionless) metadata with a local datapackage.json, without restarting the IPT. WARNING for Camtrap DP: ipt_get_datapackage_metadata returns the last PUBLISHED version, so replacing with an edit of it discards changes made in the IPT's metadata forms since that publication. The IPT resets name/id/created, keeps the version, and drops properties it does not model (listed as `dropped` when the draft can be read back). Publish afterwards so GBIF picks the change up.",
    { shortname, path: z.string(), validate: z.boolean().default(true), confirm },
    async ({ shortname, path, validate, confirm }, m) =>
      confirm ? opText(await m.replaceDatapackageMetadata(shortname, assertReadablePath(path, "json"), validate)) : needConfirm("This overwrites the resource's current data package metadata."),
  );

  write(
    "ipt_cancel_publication",
    "Stop a publication that is running or stuck (the resource shows as locked / 'publication in progress') and restore the last published version. The IPT-level alternative to restarting it for a stuck resource.",
    { shortname, confirm },
    async ({ shortname, confirm }, m) => (confirm ? opText(await m.cancelPublication(shortname)) : needConfirm(`This cancels the running publication of "${shortname}" and restores its last published version.`)),
  );

  write(
    "ipt_add_source",
    "Add a data source: a local file (.txt/.csv/.tsv/.xlsx/.zip), a URL, or an (unconfigured) SQL source. Text files are validated first and refused when they have problems (embedded newlines/tabs, bad encoding, …) unless skipValidation.",
    {
      shortname,
      type: z.enum(["file", "url", "sql"]),
      path: z.string().optional().describe("file: local path"),
      url: z.string().url().optional().describe("url: address of the file"),
      name: z.string().optional().describe("Source name (required for url and sql)"),
      skipValidation: z.boolean().default(false),
      delimiter: z.string().optional().describe("Delimiter used to validate the file (default: tab for .txt/.tsv, comma for .csv)"),
    },
    async ({ shortname, type, path, url, name, skipValidation, delimiter }, m) => {
      if (type === "file") {
        if (!path) return fail("path is required for type=file");
        path = assertReadablePath(path, "data");
        const ext = extname(path).toLowerCase();
        if (!skipValidation && [".txt", ".tsv", ".csv"].includes(ext)) {
          const report = await validateTsvFile(path, { delimiter: delimiter ?? (ext === ".csv" ? "," : "\t") });
          if (!report.ok) return fail({ ok: false, refused: "file failed validation; fix it or set skipValidation", report });
        }
        return opText(await m.addSourceFile(shortname, path, name));
      }
      if (type === "url") {
        if (!url || !name) return fail("url and name are required for type=url");
        return opText(await m.addSourceUrl(shortname, url, name));
      }
      if (!name) return fail("name is required for type=sql");
      return opText(await m.addSourceSql(shortname, name));
    },
  );

  write(
    "ipt_configure_source",
    "Set how a source is parsed (delimiter, quote character, header lines, encoding, date format) and re-analyse it; for SQL sources pass raw `fields` (host, database, credentials, SQL).",
    {
      shortname,
      source: z.string(),
      delimiter: z.string().optional().describe("e.g. \\t or ,"),
      enclosedBy: z.string().optional(),
      headerLines: z.number().int().min(0).optional(),
      encoding: z.string().optional(),
      dateFormat: z.string().optional(),
      multiValueDelimiter: z.string().optional(),
      analyze: z.boolean().default(true),
      fields: z.record(z.string()).optional(),
    },
    async ({ shortname, source, ...opts }, m) => opText(await m.configureSource(shortname, source, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)))),
  );

  write("ipt_delete_source", "Delete a source (its mappings must be removed first).", { shortname, source: z.string(), confirm }, async ({ shortname, source, confirm }, m) =>
    confirm ? opText(await m.deleteSource(shortname, source)) : needConfirm(`This deletes source "${source}".`),
  );

  write(
    "ipt_add_mapping",
    "Map a source to an extension (Occurrence, Taxon, Event, …). The IPT automaps columns by header name. Refuses a second mapping of the same row type unless allowDuplicate (it multiplies published records).",
    { shortname, rowType: z.string(), source: z.string(), allowDuplicate: z.boolean().default(false) },
    async ({ shortname, rowType, source, allowDuplicate }, m) => opText(await m.addMapping(shortname, rowType, source, allowDuplicate)),
  );

  write(
    "ipt_set_mapping",
    "Adjust a mapping: columns maps a term (URI, dwc:name or name) to a source column header (null to unmap); defaults gives constant values; idColumn picks the record ID column.",
    {
      shortname,
      rowType: z.string(),
      mid: z.number().int().default(0),
      columns: z.record(z.string().nullable()).optional(),
      defaults: z.record(z.string()).optional(),
      idColumn: z.string().optional(),
    },
    async ({ shortname, rowType, mid, columns, defaults, idColumn }, m) =>
      opText(await m.setMapping(shortname, rowType, mid, { ...(columns ? { columns } : {}), ...(defaults ? { defaults } : {}), ...(idColumn ? { idColumn } : {}) })),
  );

  write("ipt_delete_mapping", "Delete a mapping.", { shortname, rowType: z.string(), mid: z.number().int().default(0), confirm }, async ({ shortname, rowType, mid, confirm }, m) =>
    confirm ? opText(await m.deleteMapping(shortname, rowType, mid)) : needConfirm("This deletes the mapping."),
  );

  write(
    "ipt_set_settings",
    "Save publication options (page auto-publish: updateFrequency, updateFrequencyDayOfWeek, updateFrequencyDay, updateFrequencyTime, skipUnchanged, …).",
    { shortname, page: z.enum(IptManager.SETTINGS_PAGES), values: z.record(z.string()) },
    async ({ shortname, page, values }, m) => opText(await m.setSettings(shortname, page, values)),
  );

  write(
    "ipt_publish",
    "Validate then publish a new version (DwC-A + EML). Refuses when the pre-flight finds problems. Waits for completion by default. Note: making a resource public also needs a publication to take effect.",
    { shortname, summary: z.string().default("").describe("Change summary stored in the version history"), metadataOnly: z.boolean().default(false), wait: z.boolean().default(true), confirm },
    async ({ shortname, summary, metadataOnly, wait, confirm }, m) => {
      if (!confirm) {
        const v = await m.validateResource(shortname, { metadataOnly });
        return needConfirm(`Publishing creates version ${v.status.nextVersion ?? "next"} of "${shortname}". Pre-flight: ${v.ready ? "ready" : `NOT ready (${v.problems.length} problem(s): ${v.problems.slice(0, 5).join("; ")})`}.`);
      }
      const r = await m.publish(shortname, summary, { metadataOnly });
      if (!r.ok) return fail(r);
      if (!wait || r.finished) return text({ ...r, state: r.finished ? "completed" : "running" });
      const rep = await m.waitForPublication(shortname, 30 * 60_000, 1500, r.version);
      const out = { ...r, state: rep.state, message: rep.message };
      return rep.state === "completed" ? text(out) : fail(out);
    },
  );

  write(
    "ipt_set_visibility",
    "Request public/private visibility. The IPT applies the change at the next publication (a new version).",
    { shortname, visibility: z.enum(["public", "private"]), confirm },
    async ({ shortname, visibility, confirm }, m) => (confirm ? opText(await m.setVisibility(shortname, visibility)) : needConfirm(`This makes "${shortname}" ${visibility} at the next publication.`)),
  );

  write("ipt_delete_resource", "Delete a resource from the IPT (never touches the GBIF registry).", { shortname, confirm }, async ({ shortname, confirm }, m) =>
    confirm ? opText(await m.deleteResource(shortname)) : needConfirm(`This deletes "${shortname}" and all its published versions from the IPT.`),
  );
}
