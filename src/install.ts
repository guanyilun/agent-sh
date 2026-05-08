import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CONFIG_DIR, getSettings } from "./settings.js";

// Kept in sync with extension-loader.ts SCRIPT_EXTS.
const SCRIPT_EXTS = [".js", ".mjs", ".ts", ".tsx", ".mts"];

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../");
const BUNDLED_DIR = path.join(PACKAGE_ROOT, "examples/extensions");
const EXT_DIR = path.join(CONFIG_DIR, "extensions");

interface InstallOpts {
  force?: boolean;
}

interface ResolvedSource {
  sourcePath: string;
  /** Filesystem name used under ~/.agent-sh/extensions/. Includes the file
   *  extension for single-file resolves so the loader's SCRIPT_EXTS check matches. */
  name: string;
  isDirectory: boolean;
}

interface Resolver {
  canHandle?(spec: string): boolean;
  resolve(spec: string): Promise<ResolvedSource>;
}

export function listBundled(): string[] {
  if (!fs.existsSync(BUNDLED_DIR)) return [];
  return fs.readdirSync(BUNDLED_DIR).map((n) => n.replace(/\.(ts|js|mjs)$/, ""));
}

/** Heuristic: a backend named "pi" is typically provided by an extension called "pi-bridge". */
export function suggestBridgeFor(backend: string): string | null {
  const candidate = `${backend}-bridge`;
  return listBundled().includes(candidate) ? candidate : null;
}

const bundledResolver: Resolver = {
  resolve: async (spec) => {
    const candidates = [
      { p: path.join(BUNDLED_DIR, spec), name: spec },
      { p: path.join(BUNDLED_DIR, `${spec}.ts`), name: `${spec}.ts` },
      { p: path.join(BUNDLED_DIR, `${spec}.js`), name: `${spec}.js` },
    ];
    for (const c of candidates) {
      if (fs.existsSync(c.p)) {
        const isDirectory = fs.statSync(c.p).isDirectory();
        return { sourcePath: c.p, name: c.name, isDirectory };
      }
    }
    const available = listBundled();
    throw new Error(
      `No bundled extension named "${spec}".\n\n` +
        `Available:\n${available.map((n) => `  ${n}`).join("\n")}`,
    );
  },
};

const npmResolver: Resolver = {
  canHandle: (spec) => spec.startsWith("npm:"),
  resolve: async () => {
    throw new Error("npm: source is not yet implemented");
  },
};

const githubResolver: Resolver = {
  canHandle: (spec) => spec.startsWith("github:") || spec.startsWith("https://github.com/"),
  resolve: async () => {
    throw new Error("github: source is not yet implemented");
  },
};

const fileResolver: Resolver = {
  canHandle: (spec) =>
    spec.startsWith("file:") || spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../"),
  resolve: async (spec) => {
    const raw = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
    const isDirectory = fs.statSync(abs).isDirectory();
    return { sourcePath: abs, name: path.basename(abs), isDirectory };
  },
};

const PREFIX_RESOLVERS: Resolver[] = [npmResolver, githubResolver, fileResolver];

function pickResolver(spec: string): Resolver {
  for (const r of PREFIX_RESOLVERS) if (r.canHandle?.(spec)) return r;
  return bundledResolver;
}

function maybeNpmInstall(target: string): void {
  const pkgJson = path.join(target, "package.json");
  if (!fs.existsSync(pkgJson)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  if (Object.keys(deps).length === 0) return;
  if (fs.existsSync(path.join(target, "node_modules"))) return;
  console.log(`Running npm install in ${target}...`);
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: target,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`npm install failed in ${target}; run it manually.`);
  }
}

export async function runInstall(spec: string, opts: InstallOpts = {}): Promise<void> {
  if (!spec) {
    console.error(
      "Usage: agent-sh install <name|file:|npm:|github:> [--force]\n\n" +
        "Bundled extensions:\n" +
        listBundled()
          .map((n) => `  ${n}`)
          .join("\n"),
    );
    process.exit(1);
  }

  fs.mkdirSync(EXT_DIR, { recursive: true });

  let resolved: ResolvedSource;
  try {
    resolved = await pickResolver(spec).resolve(spec);
  } catch (err) {
    console.error(`agent-sh: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const target = path.join(EXT_DIR, resolved.name);
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    if (!opts.force) {
      console.error(`agent-sh: ${target} already exists (pass --force to overwrite)`);
      process.exit(1);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  if (resolved.isDirectory) {
    fs.cpSync(resolved.sourcePath, target, { recursive: true });
    try {
      maybeNpmInstall(target);
    } catch (err) {
      console.error(`agent-sh: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    fs.copyFileSync(resolved.sourcePath, target);
  }

  console.log(`Installed: ${resolved.name} -> ${target}`);
}

export async function runUninstall(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: agent-sh uninstall <name>");
    process.exit(1);
  }
  const target = path.join(EXT_DIR, name);
  // Refuse path-traversal: target must sit directly under EXT_DIR.
  const resolvedTarget = path.resolve(target);
  const resolvedExtDir = path.resolve(EXT_DIR);
  if (!resolvedTarget.startsWith(resolvedExtDir + path.sep)) {
    console.error(`agent-sh: refusing to uninstall outside ${EXT_DIR}`);
    process.exit(1);
  }
  if (!fs.lstatSync(target, { throwIfNoEntry: false })) {
    console.error(`agent-sh: not installed: ${name}`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Uninstalled: ${name}`);
}

export function runList(): void {
  if (!fs.existsSync(EXT_DIR)) {
    console.log("No extensions installed.");
    return;
  }
  const disabled = new Set(getSettings().disabledExtensions ?? []);
  const dirents = fs.readdirSync(EXT_DIR, { withFileTypes: true });
  const loadable = dirents.filter((d) => {
    if (d.name.startsWith(".")) return false;
    const nameForDisable = d.name.replace(/\.[^.]+$/, "");
    if (disabled.has(nameForDisable)) return false;
    if (d.isDirectory() || d.isSymbolicLink()) return true;
    return SCRIPT_EXTS.some((ext) => d.name.endsWith(ext));
  });
  if (loadable.length === 0) {
    console.log("No extensions installed.");
    return;
  }
  console.log("Installed extensions:");
  for (const d of loadable) {
    const full = path.join(EXT_DIR, d.name);
    const suffix = d.isSymbolicLink() ? ` -> ${fs.readlinkSync(full)}` : "";
    console.log(`  ${d.name}${suffix}`);
  }
}
