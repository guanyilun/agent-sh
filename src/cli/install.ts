import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CONFIG_DIR, getSettings } from "../core/settings.js";

// Kept in sync with extension-loader.ts SCRIPT_EXTS.
const SCRIPT_EXTS = [".js", ".mjs", ".ts", ".tsx", ".mts"];

function hasIndexFile(dir: string): boolean {
  return SCRIPT_EXTS.some((ext) => fs.existsSync(path.join(dir, `index${ext}`)));
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
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

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  name?: string;
}

function readPackageJson(target: string): PackageJson | null {
  const pkgJson = path.join(target, "package.json");
  if (!fs.existsSync(pkgJson)) return null;
  return JSON.parse(fs.readFileSync(pkgJson, "utf-8")) as PackageJson;
}

/** Version of the host agent-sh package this CLI is running from. */
function hostAgentShVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Pin the extension's `agent-sh` dep to the host's exact version so
 *  `npm install` lands a copy that matches the running host. Without this
 *  an extension shipping `agent-sh: "^0.12.0"` would get 0.12.x even when
 *  the host is 0.14.x, producing runtime/type drift inside the extension. */
function syncAgentShVersion(target: string): void {
  const hostVersion = hostAgentShVersion();
  if (!hostVersion) return;
  const pkgJson = path.join(target, "package.json");
  if (!fs.existsSync(pkgJson)) return;
  const raw = fs.readFileSync(pkgJson, "utf-8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
  let changed = false;
  for (const section of sections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    const d = deps as Record<string, string>;
    const current = d["agent-sh"];
    if (typeof current !== "string") continue;
    // file: deps point at a local checkout — rewriteFileDeps handles them.
    if (current.startsWith("file:")) continue;
    if (current === hostVersion) continue;
    d["agent-sh"] = hostVersion;
    changed = true;
  }
  if (changed) fs.writeFileSync(pkgJson, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Relative `file:` deps in bundled extensions (e.g. `"agent-sh": "file:../../.."`)
 *  point at the wrong location after the source is copied into ~/.agent-sh/extensions/.
 *  Resolve them against the original source dir so npm install in the target succeeds. */
function rewriteFileDeps(target: string, sourcePath: string): void {
  const pkgJson = path.join(target, "package.json");
  if (!fs.existsSync(pkgJson)) return;
  const raw = fs.readFileSync(pkgJson, "utf-8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
  let changed = false;
  for (const section of sections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
      if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
      const rel = spec.slice("file:".length);
      if (path.isAbsolute(rel)) continue;
      (deps as Record<string, string>)[name] = `file:${path.resolve(sourcePath, rel)}`;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(pkgJson, `${JSON.stringify(pkg, null, 2)}\n`);
}

function maybeNpmInstall(target: string, pkg: PackageJson): void {
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

function normalizeBin(pkg: PackageJson): Record<string, string> {
  if (!pkg.bin) return {};
  if (typeof pkg.bin === "string") {
    const name = pkg.name?.startsWith("@") ? pkg.name.split("/")[1]! : pkg.name;
    return name ? { [name]: pkg.bin } : {};
  }
  return pkg.bin;
}

function maybeNpmBuild(target: string, pkg: PackageJson): void {
  if (!pkg.scripts?.build) return;
  console.log(`Running npm run build in ${target}...`);
  const result = spawnSync("npm", ["run", "build"], { cwd: target, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm run build failed in ${target}; run it manually.`);
  }
}

function linkBins(target: string, pkg: PackageJson): string[] {
  const bins = normalizeBin(pkg);
  if (Object.keys(bins).length === 0) return [];
  const binDir = path.join(CONFIG_DIR, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const linked: string[] = [];
  for (const [name, relPath] of Object.entries(bins)) {
    const src = path.resolve(target, relPath);
    if (!fs.existsSync(src)) {
      console.error(`agent-sh: skipping bin "${name}" — ${src} not found`);
      continue;
    }
    try { fs.chmodSync(src, 0o755); } catch { /* ignore */ }
    const linkPath = path.join(binDir, name);
    try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
    fs.symlinkSync(src, linkPath);
    linked.push(name);
  }
  return linked;
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

  let linkedBins: string[] = [];
  if (resolved.isDirectory) {
    fs.cpSync(resolved.sourcePath, target, { recursive: true });
    try {
      rewriteFileDeps(target, resolved.sourcePath);
      syncAgentShVersion(target);
      const pkg = readPackageJson(target);
      if (pkg) {
        maybeNpmInstall(target, pkg);
        maybeNpmBuild(target, pkg);
        linkedBins = linkBins(target, pkg);
      }
    } catch (err) {
      console.error(`agent-sh: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    fs.copyFileSync(resolved.sourcePath, target);
  }

  console.log(`Installed: ${resolved.name} -> ${target}`);
  if (linkedBins.length > 0) {
    const binDir = path.join(CONFIG_DIR, "bin");
    console.log(`Linked bins: ${linkedBins.join(", ")} -> ${binDir}`);
    console.log(`Add to PATH: export PATH="${binDir}:$PATH"`);
  }
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
  const pkg = readPackageJson(target);
  if (pkg) {
    const binDir = path.join(CONFIG_DIR, "bin");
    const targetPrefix = path.resolve(target) + path.sep;
    for (const binName of Object.keys(normalizeBin(pkg))) {
      const linkPath = path.join(binDir, binName);
      try {
        const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
        if (!stat?.isSymbolicLink()) continue;
        const dest = path.resolve(binDir, fs.readlinkSync(linkPath));
        if (dest.startsWith(targetPrefix)) fs.unlinkSync(linkPath);
      } catch { /* ignore */ }
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Uninstalled: ${name}`);
}

interface ListedExtension {
  name: string;
  source: "extensions dir" | "settings.json";
  detail?: string;
}

function listFromExtDir(disabled: Set<string>): ListedExtension[] {
  if (!fs.existsSync(EXT_DIR)) return [];
  const dirents = fs.readdirSync(EXT_DIR, { withFileTypes: true });
  const out: ListedExtension[] = [];
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const nameForDisable = d.name.replace(/\.[^.]+$/, "");
    if (disabled.has(nameForDisable)) continue;
    const full = path.join(EXT_DIR, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
    }
    if (isDir) {
      if (!hasIndexFile(full)) continue;
    } else if (!SCRIPT_EXTS.some((ext) => d.name.endsWith(ext))) {
      continue;
    }
    const detail = d.isSymbolicLink() ? `-> ${fs.readlinkSync(full)}` : undefined;
    out.push({ name: d.name, source: "extensions dir", detail });
  }
  return out;
}

function listFromSettings(disabled: Set<string>): ListedExtension[] {
  const specs = getSettings().extensions ?? [];
  return specs
    .filter((s) => !disabled.has(s.replace(/\.[^.]+$/, "")))
    .map((s) => ({ name: s, source: "settings.json" as const }));
}

export function runList(): void {
  const disabled = new Set(getSettings().disabledExtensions ?? []);
  const items = [...listFromExtDir(disabled), ...listFromSettings(disabled)];
  if (items.length === 0) {
    console.log("No extensions installed.");
    return;
  }
  const nameWidth = Math.max(...items.map((i) => i.name.length));
  console.log("Installed extensions:");
  for (const item of items) {
    const padded = item.name.padEnd(nameWidth);
    const detail = item.detail ? `  ${item.detail}` : "";
    console.log(`  ${padded}  (${item.source})${detail}`);
  }
}
