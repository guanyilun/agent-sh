import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureTsSupport } from "./extension-loader.js";

/** Imports a fresh hidden .mts/.mjs copy: loaders cache by path, and tsx loads plain .ts as CommonJS. */
export async function importUserModule(file: string): Promise<Record<string, unknown>> {
  await ensureTsSupport();
  const ext = /\.m?tsx?$/.test(file) ? ".mts" : ".mjs";
  const copy = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString("hex")}${ext}`);
  try {
    fs.copyFileSync(file, copy);
  } catch {
    return import(`${pathToFileURL(file).href}?v=${Date.now()}`);
  }
  try {
    return await import(pathToFileURL(copy).href);
  } finally {
    fs.rmSync(copy, { force: true });
  }
}
