import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

export type UploadKind = "data" | "eml" | "dwca";

const EXT: Record<UploadKind, string[]> = {
  data: [".txt", ".tsv", ".csv", ".xls", ".xlsx", ".zip", ".gz"],
  eml: [".xml", ".eml"],
  dwca: [".zip"],
};

/**
 * Local files the server may read or send to the IPT. An agent (or an injected instruction) must not be
 * able to upload or inspect arbitrary files such as ~/.ssh, ~/.mcp.json or ~/.config, so a path must:
 * exist as a regular file, have an extension that fits the purpose, contain no hidden (dot) directory or
 * file, and, when IPT_ALLOWED_DIRS is set (":"-separated), lie inside one of those directories.
 */
export function assertReadablePath(path: string, kind: UploadKind, allowedDirs: string[] = allowedFromEnv()): string {
  const abs = resolve(path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`file not found: ${path}`);
  }
  if (!statSync(real).isFile()) throw new Error(`not a regular file: ${path}`);
  for (const candidate of [abs, real]) {
    if (candidate.split(sep).some((seg) => seg.startsWith(".") && seg.length > 1)) {
      throw new Error(`refusing to use a hidden path (${path}): data files must not live in dot-directories or be dotfiles`);
    }
  }
  const ext = extname(real).toLowerCase();
  if (!EXT[kind].includes(ext)) throw new Error(`unsupported file type "${ext || "(none)"}" for ${kind}; allowed: ${EXT[kind].join(", ")}`);
  if (allowedDirs.length > 0) {
    const inside = allowedDirs.some((d) => {
      const dir = safeReal(d);
      return real === dir || real.startsWith(dir + sep);
    });
    if (!inside) throw new Error(`path is outside IPT_ALLOWED_DIRS: ${path}`);
  }
  return real;
}

function safeReal(d: string): string {
  try {
    return realpathSync(resolve(d));
  } catch {
    return resolve(d);
  }
}

function allowedFromEnv(): string[] {
  return (process.env["IPT_ALLOWED_DIRS"] ?? "").split(":").filter(Boolean);
}
