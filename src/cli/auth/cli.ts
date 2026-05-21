import * as readline from "node:readline";
import { palette as p } from "../../utils/palette.js";
import {
  KNOWN_PROVIDERS,
  KEYS_PATH,
  loadKeysFile,
  saveKeysFile,
  resolveApiKey,
  listAllProvidersWithDiscovery,
  findProvider as findProviderById,
  type ProviderAuthInfo,
} from "./keys.js";

export async function runAuth(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }
  if (sub === "login") {
    await runLogin(args[1]);
    return;
  }
  if (sub === "logout") {
    runLogout(args[1]);
    return;
  }
  if (sub === "list" || sub === "ls" || sub === "status") {
    await runList();
    return;
  }
  console.error(`agent-sh auth: unknown subcommand "${sub}"`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  const builtins = KNOWN_PROVIDERS.map((p) => p.id).join(" | ");
  console.log(
    `agent-sh auth — manage API keys for providers\n\n` +
    `Usage:\n` +
    `  agent-sh auth login [provider]   Store an API key (prompts if omitted)\n` +
    `  agent-sh auth logout <provider>  Remove a stored key\n` +
    `  agent-sh auth list               Show configured providers and key sources\n\n` +
    `Built-in providers: ${builtins}\n` +
    `Custom providers declared in settings.json are also accepted by id.\n\n` +
    `Keys are stored in ${KEYS_PATH} (chmod 0600).\n` +
    `Resolution order: settings.json > keys.json > env var.\n`,
  );
}

async function runLogin(providerArg: string | undefined): Promise<void> {
  let provider: ProviderAuthInfo | null;
  if (providerArg) {
    const id = providerArg.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_\-./:]*$/.test(id)) {
      console.error(`agent-sh auth: invalid provider id "${providerArg}".`);
      process.exit(1);
    }
    provider = findProviderById(id);
    if (!provider) {
      console.error(
        `${p.warning}Note:${p.reset} no built-in or settings.json provider named "${id}". ` +
        `Storing the key anyway — it will resolve once an extension or settings.json declares the provider.`,
      );
      provider = { id, label: id, unattached: true };
    }
  } else {
    provider = await pickProvider();
  }
  if (!provider) process.exit(1);

  const key = await promptSecret(`Enter ${provider.label} API key: `);
  const trimmed = key.trim();
  if (!trimmed) {
    console.error("agent-sh auth: empty key, nothing saved.");
    process.exit(1);
  }
  if (/\s/.test(trimmed)) {
    console.error("agent-sh auth: key contains whitespace; aborting.");
    process.exit(1);
  }

  const keys = { ...loadKeysFile() };
  keys[provider.id] = trimmed;
  saveKeysFile(keys);

  const resolved = resolveApiKey(provider.id);
  console.log(`${p.success}✓${p.reset} Saved ${provider.label} key to ${KEYS_PATH}`);
  if (resolved.source !== "keys-file") {
    console.log(
      `${p.warning}Note:${p.reset} an existing ${sourceLabel(resolved.source, provider)} entry ` +
      `takes precedence; the stored key is shadowed until you remove it.`,
    );
  }
}

function runLogout(providerArg: string | undefined): void {
  if (!providerArg) {
    console.error("Usage: agent-sh auth logout <provider>");
    process.exit(1);
  }
  const id = providerArg.toLowerCase();
  const keys = { ...loadKeysFile() };
  if (!(id in keys)) {
    console.log(`agent-sh auth: no stored key for ${id}.`);
    return;
  }
  delete keys[id];
  saveKeysFile(keys);
  console.log(`${p.success}✓${p.reset} Removed ${id} key from ${KEYS_PATH}`);
}

async function runList(): Promise<void> {
  const providers = await listAllProvidersWithDiscovery();
  console.log("Provider key status:\n");
  const idWidth = Math.max(...providers.map((p) => p.id.length));
  for (const info of providers) {
    const resolved = resolveApiKey(info.id);
    const padded = info.id.padEnd(idWidth);
    const marker = info.custom
      ? `  ${p.dim}custom${p.reset}`
      : info.unattached
      ? `  ${p.dim}unattached${p.reset}`
      : "";
    if (resolved.key) {
      console.log(`  ${p.success}●${p.reset} ${padded}  ${p.dim}(${sourceLabel(resolved.source, info)})${p.reset}${marker}`);
    } else if (info.noAuth) {
      console.log(`  ${p.success}●${p.reset} ${padded}  ${p.dim}(no auth required)${p.reset}${marker}`);
    } else {
      console.log(`  ${p.muted}○${p.reset} ${padded}  ${p.dim}(not configured)${p.reset}${marker}`);
    }
  }
  const example = providers[0]!.id;
  console.log(`\n${p.muted}Login with:${p.reset} agent-sh auth login <id>   ${p.dim}(e.g. agent-sh auth login ${example})${p.reset}`);
}

async function pickProvider(): Promise<ProviderAuthInfo | null> {
  if (!process.stdin.isTTY) {
    console.error("agent-sh auth: no provider specified and stdin is not a TTY.");
    return null;
  }
  const providers = await listAllProvidersWithDiscovery();
  console.log("Select a provider:");
  providers.forEach((info, i) => {
    const resolved = resolveApiKey(info.id);
    const tag = resolved.key
      ? `${p.dim}(currently from ${sourceLabel(resolved.source, info)})${p.reset}`
      : info.noAuth
      ? `${p.dim}(no auth required)${p.reset}`
      : `${p.dim}(not configured)${p.reset}`;
    const labelStr = info.custom
      ? `${p.dim}custom${p.reset}`
      : info.unattached
      ? `${p.dim}unattached${p.reset}`
      : `${p.dim}${info.label}${p.reset}`;
    console.log(`  ${i + 1}) ${info.id.padEnd(12)} ${labelStr}  ${tag}`);
  });
  const answer = await promptLine("Choice [1]: ");
  const idx = answer.trim() === "" ? 0 : Number(answer.trim()) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= providers.length) {
    console.error("agent-sh auth: invalid selection.");
    return null;
  }
  return providers[idx]!;
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          process.stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ""));
        }
      });
      return;
    }

    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf-8");

    let buf = "";
    const finish = (value: string | null): void => {
      stdout.write("\n");
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      if (value === null) process.exit(130);
      resolve(value);
    };
    const onData = (ch: string): void => {
      for (const c of ch) {
        if (c === "\n" || c === "\r" || c === "\x04") {
          finish(buf);
          return;
        }
        if (c === "\x03") {
          finish(null);
          return;
        }
        if (c === "\x7f" || c === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (c < " ") continue;
        buf += c;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function sourceLabel(source: string, info?: ProviderAuthInfo): string {
  switch (source) {
    case "settings": return "settings.json";
    case "keys-file": return "keys.json";
    case "env": return info ? `$${info.envVar}` : "env var";
    default: return source;
  }
}
