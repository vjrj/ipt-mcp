import { readFileSync } from "node:fs";

export interface InstanceConfig {
  /** Name the agent uses to pick the instance (e.g. "demo", "prod"). */
  name: string;
  url: string;
  email?: string | undefined;
  password?: string | undefined;
  /** Block every tool that changes anything on this IPT. */
  readonly: boolean;
}

export interface Config {
  instances: InstanceConfig[];
  /** Instance used when a tool call does not name one. */
  default: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const truthy = (v: string | undefined) => /^(1|true|yes)$/i.test(v ?? "");

/** Replace ${VAR} with the environment variable; unset variables give undefined, so no secret has to live in the file. */
function expand(value: unknown, env: NodeJS.ProcessEnv, where: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  let missing = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => {
    const x = env[v];
    if (x === undefined || x === "") missing = true;
    return x ?? "";
  });
  return missing ? undefined : out;
}

/**
 * One IPT from IPT_URL / IPT_EMAIL / IPT_PASSWORD, or several from IPT_INSTANCES: a JSON file path (or inline JSON)
 * shaped { "default": "demo", "instances": { "demo": { "url", "email", "password", "readonly" } } }.
 * String values may use ${ENV_VAR}, so passwords can stay out of the file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const globalReadonly = truthy(env["IPT_READONLY"]);
  const spec = env["IPT_INSTANCES"]?.trim();
  if (!spec) {
    return {
      default: "default",
      instances: [{ name: "default", url: env["IPT_URL"] ?? "https://ipt.gbif.org", email: env["IPT_EMAIL"], password: env["IPT_PASSWORD"], readonly: globalReadonly }],
    };
  }
  let raw: { default?: unknown; instances?: Record<string, Record<string, unknown>> };
  try {
    raw = JSON.parse(spec.startsWith("{") ? spec : readFileSync(spec, "utf8"));
  } catch (e) {
    throw new Error(`IPT_INSTANCES is neither valid JSON nor a readable JSON file: ${(e as Error).message}`);
  }
  const entries = Object.entries(raw.instances ?? {});
  if (entries.length === 0) throw new Error('IPT_INSTANCES needs an "instances" object with at least one IPT');
  const instances = entries.map(([name, c]) => {
    if (!NAME.test(name)) throw new Error(`invalid instance name "${name}" (letters, digits, _ . -)`);
    const url = expand(c["url"], env, `instances.${name}.url`);
    if (!url) throw new Error(`instances.${name}.url is missing (or uses an unset environment variable)`);
    return {
      name,
      url,
      email: expand(c["email"], env, `instances.${name}.email`),
      password: expand(c["password"], env, `instances.${name}.password`),
      readonly: globalReadonly || c["readonly"] === true,
    } satisfies InstanceConfig;
  });
  const def = typeof raw.default === "string" ? raw.default : instances[0]!.name;
  if (!instances.some((i) => i.name === def)) throw new Error(`default instance "${def}" is not in instances: ${instances.map((i) => i.name).join(", ")}`);
  return { instances, default: def };
}
