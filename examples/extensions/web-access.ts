/**
 * Web Access extension — web search & content extraction for agent-sh.
 *
 * Provides two tools:
 *   - web_search:  Search the web via Exa MCP (free, no API key)
 *   - web_fetch:   Extract page content as clean markdown
 *                   Fallback chain: Jina Reader → direct fetch
 *
 * Optional configuration (~/.agent-sh/settings.json):
 *   {
 *     "web-access": {
 *       "timeout": 30000,
 *       "searchNumResults": 5
 *     }
 *   }
 *
 * Inspired by: https://github.com/nicobailon/pi-web-access
 */
import type { ExtensionContext } from "agent-sh/types";

// ── Constants ────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

const JINA_READER_URL = "https://r.jina.ai";

// ── Exa MCP search (free, no key, no session) ───────────────────────

async function exaSearch(
  query: string,
  numResults: number,
  timeout: number,
): Promise<string> {
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          numResults,
          type: "auto",
          livecrawl: "fallback",
          contextMaxCharacters: 3000,
        },
      },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    throw new Error(`Exa MCP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const body = await res.text();

  // Parse SSE or JSON response
  let parsed: any = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(line.charAt(5) === " " ? 6 : 5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload);
      if (candidate?.result || candidate?.error) { parsed = candidate; break; }
    } catch { /* skip */ }
  }

  if (!parsed) {
    try { parsed = JSON.parse(body); } catch { /* skip */ }
  }

  if (!parsed) throw new Error("Exa MCP returned empty response");
  if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
  if (parsed.result?.isError) {
    const msg = parsed.result.content?.find((c: any) => c.type === "text")?.text;
    throw new Error(msg ?? "Exa MCP returned an error");
  }

  const text = parsed.result?.content?.find(
    (c: any) => c.type === "text" && c.text?.trim(),
  )?.text;

  if (!text) throw new Error("Exa MCP returned empty content");
  return text;
}

// ── Jina Reader (free, no key) ───────────────────────────────────────

async function jinaRead(url: string, timeout: number): Promise<string> {
  const res = await fetch(`${JINA_READER_URL}/${url}`, {
    headers: { Accept: "text/markdown", "X-Return-Format": "markdown" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Jina Reader ${res.status}`);
  return res.text();
}

// ── Direct fetch (last resort) ───────────────────────────────────────

async function directFetch(url: string, timeout: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return JSON.stringify(await res.json(), null, 2);
  return res.text();
}

// ── Extension entry point ────────────────────────────────────────────

export default function activate(ctx: ExtensionContext) {
  const config = ctx.getExtensionSettings("web-access", {
    timeout: 30000,
    searchNumResults: 5,
  });

  const timeout = config.timeout ?? 30000;
  const numResults = config.searchNumResults ?? 5;

  // ── System instruction ────────────────────────────────────────────

  ctx.registerInstruction(
    "You have access to web search and fetching tools. " +
    "Use `web_search` to find information on the web, then `web_fetch` to read specific pages. " +
    "Use `web_fetch` with `raw: true` for JSON APIs or plain text files.",
  );

  // ── Tool: web_search (Exa MCP, free) ────────────────────────────

  ctx.registerTool({
    name: "web_search",
    displayName: "Web Search",
    description:
      "Search the web and return results with titles, URLs, and content snippets. " +
      "Free, no API key required. Powered by Exa.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        numResults: {
          type: "number",
          description: `Number of results (default: ${numResults}, max: 10)`,
        },
      },
      required: ["query"],
    },
    async execute(args: { query: string; numResults?: number }) {
      const n = Math.min(args.numResults ?? numResults, 10);
      try {
        const results = await exaSearch(args.query, n, timeout);
        return { content: results, exitCode: 0, isError: false };
      } catch (err: any) {
        return { content: `Search failed: ${err.message}`, exitCode: 1, isError: true };
      }
    },
    formatCall(args: { query: string }) {
      return `Searching: "${args.query}"`;
    },
  });

  // ── Tool: web_fetch ─────────────────────────────────────────────

  ctx.registerTool({
    name: "web_fetch",
    displayName: "Web Fetch",
    description:
      "Fetch a URL and extract its content as clean markdown. " +
      "Handles web pages, articles, and documentation. " +
      "Uses Jina Reader, with direct fetch as fallback.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        raw: {
          type: "boolean",
          description:
            "If true, fetch raw content directly (useful for JSON APIs, raw text files)",
        },
      },
      required: ["url"],
    },
    async execute(args: { url: string; raw?: boolean }) {
      if (args.raw) {
        try {
          const content = await directFetch(args.url, timeout);
          return { content, exitCode: 0, isError: false };
        } catch (err: any) {
          return { content: `Fetch failed: ${err.message}`, exitCode: 1, isError: true };
        }
      }

      // Fallback chain: Jina Reader → direct fetch
      try {
        const content = await jinaRead(args.url, timeout);
        return { content, exitCode: 0, isError: false };
      } catch { /* fall through */ }

      try {
        const content = await directFetch(args.url, timeout);
        return { content, exitCode: 0, isError: false };
      } catch (err: any) {
        return { content: `All fetch methods failed: ${err.message}`, exitCode: 1, isError: true };
      }
    },
    formatCall(args: { url: string }) {
      return `Fetching: ${args.url}`;
    },
  });
}
