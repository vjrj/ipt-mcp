import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Field } from "./html.ts";

export interface IptCredentials {
  email: string;
  password: string;
}

export interface IptDataset {
  id: string;
  title: string;
  version?: number;
  lastPublished?: string;
  records?: number;
  core?: string;
  gbifKey?: string;
  archiveUrl?: string;
  emlUrl?: string;
}

type Fetch = typeof fetch;

export interface ManagedResource {
  shortname: string;
  title: string;
  /** Remaining table cells as plain text (organisation, type, status, dates, … in the IPT's language). */
  cells: string[];
}

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();

export function parseManagedRow(cells: string[]): ManagedResource {
  const link = cells.find((c) => /resource\?r=|resource\.do\?r=/.test(c)) ?? "";
  const shortname = decodeURIComponent(link.match(/[?&]r=([^'"&]+)/)?.[1] ?? "");
  return { shortname, title: plain(link), cells: cells.filter((c) => c !== link).map(plain).filter(Boolean) };
}

export interface PageResult {
  status: number;
  /** Set when the IPT answered with a redirect (form accepted); path relative to the IPT base. */
  redirectedTo?: string;
  html: string;
  path: string;
}

/** Minimal cookie jar: enough for JSESSIONID + the IPT login CSRF cookie. */
class CookieJar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ""] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export class IptClient {
  readonly base: string;
  private jar = new CookieJar();
  private loggedIn = false;
  private cred?: IptCredentials;
  private relogging?: Promise<void>;

  constructor(baseUrl: string, private readonly fetchImpl: Fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  // ---- public, unauthenticated endpoints ----

  async health(): Promise<unknown> {
    return this.getJson("/api/health");
  }

  async listDatasets(): Promise<IptDataset[]> {
    const body = (await this.getJson("/inventory/v2/dataset")) as { resources?: Array<Record<string, any>> };
    return (body.resources ?? []).map((r) => ({
      id: String(r["id"]),
      title: String(r["title"] ?? ""),
      version: r["version"],
      lastPublished: r["lastPublished"],
      records: r["records"],
      core: r["additionalProperties"]?.core,
      gbifKey: r["gbifKey"],
      archiveUrl: r["archive"]?.[0]?.url,
      emlUrl: r["metadata"]?.[0]?.url,
    }));
  }

  async getEml(shortname: string): Promise<string> {
    const res = await this.request(`/eml.do?r=${encodeURIComponent(shortname)}`);
    return res.text();
  }

  // ---- authenticated (session + CSRF login token) ----

  /**
   * IPT login flow: GET /login.do sets a CSRFtoken cookie and renders the same token
   * in a hidden input; POST /login.do must echo it back with email + password.
   */
  async login(cred: IptCredentials): Promise<void> {
    this.cred = cred;
    const page = await this.request("/login.do");
    const html = await page.text();
    const token = html.match(/name="csrfToken"\s+value="([^"]+)"/)?.[1];
    if (!token) throw new Error("IPT login page has no csrfToken field (unexpected IPT version or login disabled)");

    const res = await this.request("/login.do", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: token, email: cred.email, password: cred.password, login: "Login" }),
      redirect: "manual",
    });
    // Success redirects (3xx) to the previous page; failure re-renders the form (200).
    if (res.status < 300 || res.status >= 400) {
      throw new Error("IPT login failed: wrong email/password combination");
    }
    this.loggedIn = true;
    // The page parsers match the IPT's English texts; pin the session locale (IPTs default to the browser's).
    await this.raw("/home.do?request_locale=en", { redirect: "manual" }).then((r) => r.arrayBuffer()).catch(() => undefined);
  }

  /**
   * Resources the logged-in user can manage. The IPT serves them page by page (DataTables
   * server-side paging, 10 per page by default), so every page is fetched.
   */
  async listManagedResources(): Promise<ManagedResource[]> {
    if (!this.loggedIn) throw new Error("Not logged in: call login first");
    const out: ManagedResource[] = [];
    const size = 100;
    for (let start = 0; start < 100_000; start += size) {
      const page = (await this.getJson(`/manager-api/resources?start=${start}&length=${size}`)) as { aaData?: string[][]; iTotalRecords?: number };
      const rows = page.aaData ?? [];
      for (const cells of rows) out.push(parseManagedRow(cells));
      if (rows.length === 0 || out.length >= (page.iTotalRecords ?? 0)) break;
    }
    return out;
  }

  // ---- generic page access for the manager UI ----

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  /** Re-authenticate (once, shared by concurrent callers) after the IPT session expired. */
  private async relogin(): Promise<void> {
    if (!this.cred) throw new Error("IPT session expired and no credentials are stored");
    this.relogging ??= this.login(this.cred).finally(() => (this.relogging = undefined));
    await this.relogging;
  }

  private static isLoginRedirect(r: PageResult): boolean {
    return /^\/login\.do/.test(r.redirectedTo ?? "") || /^\/login\.do/.test(r.path);
  }

  /** Run a request; if the IPT bounces to the login page, log in again and retry once. */
  private async authed(fn: () => Promise<PageResult>): Promise<PageResult> {
    const r = await fn();
    if (this.loggedIn && IptClient.isLoginRedirect(r)) {
      await this.relogin();
      return fn();
    }
    return r;
  }

  /** GET a page (following redirects) and return its HTML plus the final path. */
  async getHtml(path: string): Promise<PageResult> {
    return this.authed(async () => this.follow(await this.raw(path, { redirect: "manual" }), path));
  }

  /** POST urlencoded fields. Does not follow redirects: a 3xx means the IPT accepted the form. */
  async postForm(path: string, fields: Field[]): Promise<PageResult> {
    return this.authed(async () => {
      const body = new URLSearchParams();
      for (const f of fields) body.append(f.name, f.value);
      const res = await this.raw(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      });
      return this.toResult(res, path);
    });
  }

  /** POST multipart with optional local files (streamed from disk, not read into memory). */
  async postMultipart(path: string, fields: Field[], files: Array<{ name: string; path: string }> = []): Promise<PageResult> {
    return this.authed(async () => {
      const form = new FormData();
      for (const f of fields) form.append(f.name, f.value);
      for (const f of files) form.append(f.name, await openAsBlob(f.path), basename(f.path));
      const res = await this.raw(path, { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(30 * 60_000) });
      return this.toResult(res, path);
    });
  }

  private async toResult(res: Response, path: string): Promise<PageResult> {
    const location = res.headers.get("location");
    const html = res.status >= 300 && res.status < 400 ? "" : await res.text();
    return { status: res.status, redirectedTo: location ? this.localPath(location) : undefined, html, path };
  }

  private async follow(res: Response, path: string, hops = 0): Promise<PageResult> {
    const r = await this.toResult(res, path);
    if (r.redirectedTo && hops < 5) {
      const next = await this.raw(r.redirectedTo, { redirect: "manual" });
      return this.follow(next, r.redirectedTo, hops + 1);
    }
    return r;
  }

  /** Map an absolute Location from the IPT (built from its configured base URL) onto the URL we talk to. */
  private localPath(location: string): string {
    const loc = new URL(location, this.base + "/");
    const ctx = new URL(this.base).pathname.replace(/\/$/, "");
    const p = loc.pathname.startsWith(ctx) ? loc.pathname.slice(ctx.length) : loc.pathname;
    return p + loc.search;
  }

  // ---- plumbing ----

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = this.jar.header();
    if (cookie) headers.set("cookie", cookie);
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
    this.jar.absorb(res);
    return res;
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.request(path, { headers: { accept: "application/json" } });
    return res.json();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = this.jar.header();
    if (cookie) headers.set("cookie", cookie);
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    this.jar.absorb(res);
    if (!res.ok && !(res.status >= 300 && res.status < 400 && init.redirect === "manual")) {
      // Never include request bodies/headers in errors: they may carry credentials.
      throw new Error(`IPT ${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
    }
    return res;
  }
}

/** Extract the few EML fields that matter for a quick look, without an XML dependency. */
export function summarizeEml(xml: string): { title?: string; abstract?: string; license?: string; contacts: number } {
  const pick = (re: RegExp) => xml.match(re)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    title: pick(/<dataset>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/),
    abstract: pick(/<abstract>([\s\S]*?)<\/abstract>/),
    license: pick(/<intellectualRights>([\s\S]*?)<\/intellectualRights>/)?.slice(0, 200),
    contacts: (xml.match(/<contact>/g) ?? []).length,
  };
}
