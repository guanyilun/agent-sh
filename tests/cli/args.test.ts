import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/args.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

test("parseArgs returns defaults when given an empty argv and env", () => {
  const cfg = parseArgs([], EMPTY_ENV);
  assert.equal(cfg.shell, "/bin/bash");
  assert.equal(cfg.model, undefined);
  assert.equal(cfg.apiKey, undefined);
  assert.equal(cfg.baseURL, undefined);
  assert.equal(cfg.provider, undefined);
  assert.equal(cfg.backend, undefined);
  assert.equal(cfg.extensions, undefined);
});

test("parseArgs picks up SHELL, OPENAI_API_KEY, OPENAI_BASE_URL from env", () => {
  const cfg = parseArgs([], {
    SHELL: "/bin/zsh",
    OPENAI_API_KEY: "sk-env",
    OPENAI_BASE_URL: "https://api.example.test/v1",
  });
  assert.equal(cfg.shell, "/bin/zsh");
  assert.equal(cfg.apiKey, "sk-env");
  assert.equal(cfg.baseURL, "https://api.example.test/v1");
});

test("--api-key overrides OPENAI_API_KEY from env", () => {
  const cfg = parseArgs(["--api-key", "sk-flag"], { OPENAI_API_KEY: "sk-env" });
  assert.equal(cfg.apiKey, "sk-flag");
});

test("--base-url overrides OPENAI_BASE_URL from env", () => {
  const cfg = parseArgs(["--base-url", "https://flag/v1"], {
    OPENAI_BASE_URL: "https://env/v1",
  });
  assert.equal(cfg.baseURL, "https://flag/v1");
});

test("--shell overrides $SHELL", () => {
  const cfg = parseArgs(["--shell", "/usr/local/bin/fish"], { SHELL: "/bin/zsh" });
  assert.equal(cfg.shell, "/usr/local/bin/fish");
});

test("parseArgs captures --model, --provider, --backend", () => {
  const cfg = parseArgs(
    ["--model", "gpt-5", "--provider", "openrouter", "--backend", "pi"],
    EMPTY_ENV,
  );
  assert.equal(cfg.model, "gpt-5");
  assert.equal(cfg.provider, "openrouter");
  assert.equal(cfg.backend, "pi");
});

test("-e splits comma-separated extensions", () => {
  const cfg = parseArgs(["-e", "foo,bar,baz"], EMPTY_ENV);
  assert.deepEqual(cfg.extensions, ["foo", "bar", "baz"]);
});

test("repeated -e accumulates instead of replacing", () => {
  const cfg = parseArgs(["-e", "foo,bar", "--extensions", "baz"], EMPTY_ENV);
  assert.deepEqual(cfg.extensions, ["foo", "bar", "baz"]);
});

test("-e trims whitespace around comma-separated names", () => {
  const cfg = parseArgs(["-e", "  foo , bar  ,baz"], EMPTY_ENV);
  assert.deepEqual(cfg.extensions, ["foo", "bar", "baz"]);
});

test("a `--`-prefixed argument is consumed as a value, not treated as a flag (current behavior)", () => {
  const cfg = parseArgs(["--model", "--backend", "pi"], EMPTY_ENV);
  assert.equal(cfg.model, "--backend");
  assert.equal(cfg.backend, undefined);
});

test("trailing flag without value is ignored silently", () => {
  const cfg = parseArgs(["--backend"], EMPTY_ENV);
  assert.equal(cfg.backend, undefined);
});

test("unknown flag is ignored, surrounding flags still parse", () => {
  const cfg = parseArgs(["--unknown-flag", "--backend", "pi"], EMPTY_ENV);
  assert.equal(cfg.backend, "pi");
});
