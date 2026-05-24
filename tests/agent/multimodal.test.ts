import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentText, type ImageContent } from "../../src/agent/types.js";

const DRIVER = fileURLToPath(new URL("../fixtures/multimodal-driver.ts", import.meta.url));

// ── Unit: contentText ───────────────────────────────────────────────

test("contentText returns string unchanged", () => {
  assert.equal(contentText("hello"), "hello");
});

test("contentText maps ImageContent[] to [image: mime/type] lines", () => {
  const images: ImageContent[] = [
    { type: "image", data: "abc", mimeType: "image/png" },
    { type: "image", data: "def", mimeType: "image/jpeg" },
  ];
  assert.equal(contentText(images), "[image: image/png]\n[image: image/jpeg]");
});

// ── Integration driver ──────────────────────────────────────────────

interface CapturedEvent {
  event: string;
  payload: any;
}

interface DriverResult {
  events: CapturedEvent[];
  systemPrompt: string;
  exitCode: number | null;
}

async function runDriver(
  provider: { id: string; apiKey?: string; models: Array<{ id: string; modalities?: ("text" | "image")[] }> },
): Promise<DriverResult> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-mm-"));
  try {
    return await new Promise<DriverResult>((resolve, reject) => {
      const child = spawn(
        "node",
        ["--import", "tsx", DRIVER, JSON.stringify({ provider })],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            AGENT_SH_HOME: home,
            AGENT_SH_SKIP_SHELL_ENV: "1",
            OPENROUTER_API_KEY: "sk-test",
            OPENAI_API_KEY: "",
            DEEPSEEK_API_KEY: "",
            OPENAI_BASE_URL: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c) => { stdout += c.toString(); });
      child.stderr!.on("data", (c) => { stderr += c.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const line = stdout.trim().split(/\r?\n/).pop() ?? "";
          const parsed = JSON.parse(line) as { events: CapturedEvent[]; systemPrompt: string };
          resolve({ events: parsed.events, systemPrompt: parsed.systemPrompt, exitCode: code });
        } catch (err) {
          reject(new Error(`driver output not JSON.\nexit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}\nparse error: ${(err as Error).message}`));
        }
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function pickEvents(events: CapturedEvent[], name: string): any[] {
  return events.filter((e) => e.event === name).map((e) => e.payload);
}

// ── System prompt ───────────────────────────────────────────────────

test("system prompt includes Image Support when model has image modality", async () => {
  const result = await runDriver({
    id: "test-vision",
    apiKey: "sk-test",
    models: [{ id: "vision-model", modalities: ["text", "image"] }],
  });

  assert.ok(
    result.systemPrompt.includes("Image Support"),
    "system prompt should include Image Support section",
  );
});

test("system prompt excludes Image Support when model has no modalities", async () => {
  const result = await runDriver({
    id: "test-text",
    apiKey: "sk-test",
    models: [{ id: "text-model" }],
  });

  assert.ok(
    !result.systemPrompt.includes("Image Support"),
    "system prompt should not include Image Support section",
  );
});

test("system prompt excludes Image Support when modalities is text-only", async () => {
  const result = await runDriver({
    id: "test-text-only",
    apiKey: "sk-test",
    models: [{ id: "text-model", modalities: ["text"] }],
  });

  assert.ok(
    !result.systemPrompt.includes("Image Support"),
    "system prompt should not include Image Support when only text modality",
  );
});
