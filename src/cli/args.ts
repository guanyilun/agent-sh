import { PACKAGE_VERSION } from "../utils/package-version.js";
import type { AppConfig } from "../shell/host-types.js";

const HELP_TEXT = `agent-sh — a shell-first terminal where AI is one keystroke away

Usage: agent-sh [options]
       agent-sh init [--force]            Scaffold ~/.agent-sh/ (settings, examples, AGENTS.md)
       agent-sh install <spec> [--force] [--sync-deps]
                                          Install an extension (bundled name, file:, npm:, github:)
                                          --sync-deps rewrites a stale agent-sh pin to the host version
       agent-sh uninstall <name>          Remove an installed extension
       agent-sh list                      List installed extensions
       agent-sh auth login [provider]     Store an API key for a built-in provider
       agent-sh auth logout <provider>    Remove a stored key
       agent-sh auth list                 Show configured providers

Provider Profiles:
  --provider <name>   Use a provider from ~/.agent-sh/settings.json
  --model <name>      Override default model

Direct LLM API:
  --api-key <key>     API key for OpenAI-compatible provider (or set OPENAI_API_KEY)
  --base-url <url>    Base URL for API (or set OPENAI_BASE_URL)

General Options:
  --backend <name>    Agent backend to launch (e.g. ash, pi); overrides settings.defaultBackend for this session
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  -e, --extensions    Extensions to load (comma-separated, repeatable)
  -h, --help          Show this help
  -V, --version       Print version and exit

Environment Variables:
  OPENAI_API_KEY     API key for LLM provider
  OPENAI_BASE_URL    Base URL override (e.g., http://localhost:11434/v1 for Ollama)

Examples:
  # Use a configured provider
  agent-sh --provider openai

  # Direct API access
  agent-sh --api-key "$KEY" --model gpt-4o

  # Local model via Ollama
  agent-sh --base-url http://localhost:11434/v1 --model llama3

Inside the shell:
  Type normally        Commands run in your real shell
  > <query>           Ask the AI agent (it decides how to help)
  > /help             Show available slash commands
  Ctrl-C              Cancel agent response (or signal shell as usual)
`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): AppConfig {
  let model: string | undefined;
  let extensions: string[] | undefined;
  let provider: string | undefined;
  let backend: string | undefined;
  let shell = env.SHELL || "/bin/bash";

  let apiKey: string | undefined = env.OPENAI_API_KEY;
  let baseURL: string | undefined = env.OPENAI_BASE_URL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      model = argv[++i]!;
    } else if (arg === "--api-key" && argv[i + 1]) {
      apiKey = argv[++i]!;
    } else if (arg === "--base-url" && argv[i + 1]) {
      baseURL = argv[++i]!;
    } else if (arg === "--provider" && argv[i + 1]) {
      provider = argv[++i]!;
    } else if (arg === "--backend" && argv[i + 1]) {
      backend = argv[++i]!;
    } else if (arg === "--shell" && argv[i + 1]) {
      shell = argv[++i]!;
    } else if ((arg === "--extensions" || arg === "-e") && argv[i + 1]) {
      const exts = argv[++i]!.split(",").map((s) => s.trim());
      extensions = extensions ? [...extensions, ...exts] : exts;
    } else if (arg === "--version" || arg === "-V") {
      console.log(PACKAGE_VERSION);
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    }
  }

  return { shell, model, extensions, apiKey, baseURL, provider, backend };
}
