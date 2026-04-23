import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".agent-sh");
const EXTENSIONS_DIR = path.join(CONFIG_DIR, "extensions");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
const EXAMPLE_PATH = path.join(CONFIG_DIR, "settings.example.json");
const AGENTS_PATH = path.join(CONFIG_DIR, "AGENTS.md");

// Shape-discoverable stub — all fields present, none filled in.
const STARTER_SETTINGS = {
  defaultProvider: null,
  providers: {},
  extensions: [],
  disabledBuiltins: [],
  disabledExtensions: [],
};

// Not loaded at runtime — users copy blocks from here into settings.json.
const EXAMPLE_SETTINGS = {
  defaultProvider: "openrouter",
  providers: {
    openrouter: {
      apiKey: "$OPENROUTER_API_KEY",
      baseURL: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-sonnet-4.6",
    },
    openai: {
      apiKey: "$OPENAI_API_KEY",
      defaultModel: "gpt-5",
    },
    anthropic: {
      apiKey: "$ANTHROPIC_API_KEY",
      baseURL: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-5",
    },
    ollama: {
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      defaultModel: "llama3.3",
    },
  },
  extensions: [
    "./examples/extensions/openrouter.ts",
  ],
  disabledBuiltins: [],
  disabledExtensions: [],
};

function writeIfMissing(filePath: string, content: string, force: boolean): "written" | "kept" {
  if (!force && fs.existsSync(filePath)) return "kept";
  fs.writeFileSync(filePath, content);
  return "written";
}

export function runInit(opts: { force: boolean }): void {
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

  const settingsResult = writeIfMissing(SETTINGS_PATH, JSON.stringify(STARTER_SETTINGS, null, 2) + "\n", opts.force);
  // Always refreshed — reference material, not user state.
  fs.writeFileSync(EXAMPLE_PATH, JSON.stringify(EXAMPLE_SETTINGS, null, 2) + "\n");

  console.log(`agent-sh initialized at ${CONFIG_DIR}`);
  console.log();
  console.log(`  settings.json         ${settingsResult}${opts.force ? "" : settingsResult === "kept" ? " (exists — pass --force to overwrite)" : ""}`);
  console.log(`  settings.example.json refreshed`);
  console.log(`  extensions/           ready`);
  console.log();
  console.log("Next steps:");
  console.log(`  1. Open ${SETTINGS_PATH}`);
  console.log(`  2. Copy a provider block from settings.example.json into \`providers\` and set \`defaultProvider\`.`);
  console.log(`  3. Export the referenced env var (e.g. \`export OPENROUTER_API_KEY=...\`).`);
  console.log(`  4. Run \`agent-sh\`.`);
  console.log();
  console.log(`Optional: create ${AGENTS_PATH} with standing instructions`);
  console.log(`(code style, commands to avoid, etc.) to load them into every session.`);
}
