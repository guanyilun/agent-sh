import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentText, type ImageContent } from "../../src/agent/types.js";
import { LiveView } from "../../src/agent/live-view.js";

const DRIVER = fileURLToPath(new URL("../fixtures/multimodal-driver.ts", import.meta.url));

// Minimal valid 1x1 PNG (67 bytes, red pixel).
const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

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

// ── read_file image detection ───────────────────────────────────────

interface DriverResult {
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
            OPENROUTER_API_KEY: "",
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
          const parsed = JSON.parse(line) as { systemPrompt: string };
          resolve({ systemPrompt: parsed.systemPrompt, exitCode: code });
        } catch (err) {
          reject(new Error(`driver output not JSON.\nexit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}\nparse error: ${(err as Error).message}`));
        }
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("read_file on PNG returns ImageContent with base64 data", async () => {
  const { createReadFileTool } = await import("../../src/agent/tools/read-file.js");
  const tool = createReadFileTool(() => process.cwd());

  const tmp = mkdtempSync(join(tmpdir(), "agent-sh-img-"));
  const pngPath = join(tmp, "test.png");
  try {
    writeFileSync(pngPath, MINI_PNG);
    const result = await tool.execute({ path: pngPath });

    assert.equal(result.exitCode, 0);
    assert.equal(result.isError, false);
    assert.ok(Array.isArray(result.content), "content should be ImageContent[]");
    const images = result.content as ImageContent[];
    assert.equal(images.length, 1);
    assert.equal(images[0].type, "image");
    assert.equal(images[0].mimeType, "image/png");
    assert.equal(images[0].data, MINI_PNG.toString("base64"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("read_file on text file returns string unchanged", async () => {
  const { createReadFileTool } = await import("../../src/agent/tools/read-file.js");
  const tool = createReadFileTool(() => process.cwd());

  const tmp = mkdtempSync(join(tmpdir(), "agent-sh-txt-"));
  const txtPath = join(tmp, "hello.txt");
  try {
    writeFileSync(txtPath, "hello world\n");
    const result = await tool.execute({ path: txtPath });

    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.content, "string");
    assert.ok((result.content as string).includes("hello world"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── LiveView.addToolResult ──────────────────────────────────

test("LiveView.addToolResult with string produces plain tool message", () => {
  const conv = new LiveView();
  conv.addAssistantMessage(null, [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }]);
  conv.addToolResult("call_1", "file content");

  const msgs = conv.getMessages();
  const toolMsg = msgs.find((m) => m.role === "tool") as any;
  assert.equal(toolMsg.tool_call_id, "call_1");
  assert.equal(toolMsg.content, "file content");
});

test("LiveView.addToolResult with ImageContent[] produces vision content parts", () => {
  const conv = new LiveView();
  conv.addAssistantMessage(null, [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }]);
  conv.addToolResult("call_1", [{ type: "image", data: "Zm9v", mimeType: "image/png" }]);

  const msgs = conv.getMessages();
  const toolMsg = msgs.find((m) => m.role === "tool") as any;
  assert.ok(Array.isArray(toolMsg.content), "content should be array of content parts");
  assert.equal(toolMsg.content.length, 2);

  const textPart = toolMsg.content[0];
  assert.equal(textPart.type, "text");
  assert.ok(textPart.text.includes("1 image"));

  const imagePart = toolMsg.content[1];
  assert.equal(imagePart.type, "image_url");
  assert.equal(imagePart.image_url.url, "data:image/png;base64,Zm9v");
});

test("LiveView.addToolResult with error ImageContent[] still marks error", () => {
  const conv = new LiveView();
  conv.addAssistantMessage(null, [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }]);
  conv.addToolResult("call_1", [{ type: "image", data: "Zm9v", mimeType: "image/png" }], true);

  const msgs = conv.getMessages();
  const toolMsg = msgs.find((m) => m.role === "tool") as any;
  assert.ok(Array.isArray(toolMsg.content));
  assert.ok(toolMsg.content[0].text.startsWith("Error:"));
});

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
