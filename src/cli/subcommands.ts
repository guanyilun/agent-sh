import { runInit } from "./init.js";
import { runInstall, runUninstall, runList } from "./install.js";
import { runAuth } from "./auth/cli.js";

type Subcommand = (args: string[]) => void | Promise<void>;

const SUBCOMMANDS: Record<string, Subcommand> = {
  init: (args) => runInit({ force: args.includes("--force") }),
  install: (args) => runInstall(args[0] ?? "", {
    force: args.includes("--force"),
    syncDeps: args.includes("--sync-deps"),
  }),
  uninstall: (args) => runUninstall(args[0] ?? ""),
  list: () => runList(),
  auth: (args) => runAuth(args),
};

export async function dispatchSubcommand(argv: string[]): Promise<boolean> {
  const handler = SUBCOMMANDS[argv[0] ?? ""];
  if (!handler) return false;
  await handler(argv.slice(1));
  return true;
}
