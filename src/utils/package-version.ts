/**
 * The agent-sh package version, read from package.json at load time.
 * Emitted on `agent:info` so consumers (TUI, remote peers, logs) see a
 * version that tracks releases instead of a hand-edited constant.
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// dist/utils/package-version.js → ../../package.json (project root)
const pkg = require("../../package.json") as { version?: string };

export const PACKAGE_VERSION: string = pkg.version ?? "0.0.0";
