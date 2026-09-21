#!/usr/bin/env node
// Cross-platform installer: checks Node, installs the dependencies, registers an IPT in a small config file
// (the password is never written: it is read from an environment variable) and wires the server into an MCP client.
//
//   node scripts/install.mjs                       interactive
//   node scripts/install.mjs --name demo --url https://ipt-demo.example.org --email me@example.org --client claude-desktop
//   node scripts/install.mjs --name prod --url https://ipt.example.org --email me@example.org --readonly   (adds a second IPT)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const passwordVar = (name) => `IPT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`;

export const defaultInstancesFile = (env = process.env, os = platform(), home = homedir()) =>
  os === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "ipt-mcp", "instances.json") : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "ipt-mcp", "instances.json");

export const claudeDesktopConfig = (env = process.env, os = platform(), home = homedir()) =>
  os === "win32"
    ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : os === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");

/** Add or update one IPT in the instances document. The first one added is the default. */
export function mergeInstance(doc, { name, url, email, readonly }) {
  const out = { ...doc, instances: { ...(doc?.instances ?? {}) } };
  out.instances[name] = { url, ...(email ? { email, password: `\${${passwordVar(name)}}` } : {}), ...(readonly ? { readonly: true } : {}) };
  out.default = doc?.default && out.instances[doc.default] ? doc.default : name;
  return out;
}

/** The MCP server entry every client needs. */
export const serverEntry = (instancesFile) => ({
  command: "node",
  args: ["--import", "tsx", join(root, "src", "server.ts")],
  env: { IPT_INSTANCES: instancesFile },
});

/** Insert the `ipt` server in a client config that keeps its servers under mcpServers, leaving the rest untouched. */
export function mergeClientConfig(doc, instancesFile) {
  return { ...doc, mcpServers: { ...(doc?.mcpServers ?? {}), ipt: serverEntry(instancesFile) } };
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const writeJson = (file, value, mode) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  if (mode && platform() !== "win32") chmodSync(file, mode);
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const key = k.slice(2);
    if (["readonly", "no-install", "help"].includes(key)) a[key] = true;
    else a[key] = argv[++i] ?? (() => { throw new Error(`--${key} needs a value`); })();
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 6).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js 20 or newer is required (this is ${process.version}). Install it from https://nodejs.org`);
  console.log(`✔ Node.js ${process.version}`);

  if (!args["no-install"]) {
    console.log("Installing dependencies (npm install)…");
    const r = spawnSync(platform() === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: platform() === "win32" });
    if (r.status !== 0) throw new Error("npm install failed");
    console.log("✔ Dependencies installed");
  }

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (label, def) => {
    if (!rl) return def;
    const v = (await rl.question(def ? `${label} [${def}]: ` : `${label}: `)).trim();
    return v || def;
  };
  const name = args.name ?? (await ask("Name for this IPT (e.g. demo, prod)", "default"));
  const url = args.url ?? (await ask("IPT URL (e.g. https://ipt-demo.example.org/ipt)"));
  const email = args.email ?? (await ask("Your IPT login email (empty for public, read-only queries)", ""));
  const client = args.client ?? (await ask("MCP client: claude-desktop | claude-code | print", "print"));
  rl?.close();
  if (!/^[A-Za-z0-9_.-]+$/.test(name ?? "")) throw new Error("the name may only contain letters, digits, _ . -");
  if (!/^https?:\/\//.test(url ?? "")) throw new Error("the URL must start with http:// or https://");
  if (!["claude-desktop", "claude-code", "print"].includes(client)) throw new Error("--client must be claude-desktop, claude-code or print");

  const file = resolve(args.instances ?? defaultInstancesFile());
  writeJson(file, mergeInstance(readJson(file), { name, url, email, readonly: Boolean(args.readonly) }), 0o600);
  console.log(`✔ IPT "${name}" saved in ${file}`);

  if (client === "claude-desktop") {
    const target = resolve(args.config ?? claudeDesktopConfig());
    writeJson(target, mergeClientConfig(readJson(target), file));
    console.log(`✔ Claude Desktop configured (${target}); restart it to load the server`);
  } else if (client === "claude-code") {
    const e = serverEntry(file);
    const cmd = ["claude", "mcp", "add", "ipt", "-e", `IPT_INSTANCES=${file}`, "--", e.command, ...e.args];
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: platform() === "win32" });
    if (r.error || r.status !== 0) console.log(`Could not run it automatically; run this yourself:\n  ${cmd.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}`);
    else console.log("✔ Registered in Claude Code");
  } else {
    console.log(`\nAdd this to your MCP client configuration:\n${JSON.stringify({ mcpServers: { ipt: serverEntry(file) } }, null, 2)}`);
  }

  if (email) {
    const v = passwordVar(name);
    console.log(`\nLast step: the password is not stored anywhere by this tool. Set ${v} in the environment that launches your MCP client:`);
    console.log(platform() === "win32" ? `  setx ${v} "your-password"      (then restart the client)` : `  export ${v}='your-password'      (for example in ~/.profile or your secrets manager)`);
  }
  console.log("\nAdd more IPTs by running this installer again with another --name (e.g. prod). Try it: ask your assistant to “list the IPTs you can use”.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n✖ ${e.message}`);
    process.exit(1);
  });
}
