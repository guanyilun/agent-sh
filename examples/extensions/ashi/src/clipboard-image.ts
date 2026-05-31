import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

export interface CapturedImage {
  /** Base64-encoded image data (no data: URL prefix). */
  data: string;
  mimeType: string;
}

let counter = 0;

/** Terminals don't deliver image bytes through paste, so we read the macOS
 *  pasteboard directly via osascript. Null when the clipboard holds no image. */
export async function readClipboardImage(): Promise<CapturedImage | null> {
  if (process.platform !== "darwin") return null;
  const tmp = join(tmpdir(), `ashi-clip-${process.pid}-${counter++}.png`);
  try {
    await exec("osascript", [
      "-e", "set png_data to (the clipboard as «class PNGf»)",
      "-e", `set fp to open for access POSIX file ${JSON.stringify(tmp)} with write permission`,
      "-e", "write png_data to fp",
      "-e", "close access fp",
    ]);
  } catch {
    return null;
  }
  try {
    const buf = await readFile(tmp);
    if (buf.length === 0) return null;
    return { data: buf.toString("base64"), mimeType: "image/png" };
  } catch {
    return null;
  } finally {
    void unlink(tmp).catch(() => {});
  }
}
