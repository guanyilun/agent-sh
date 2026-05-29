/**
 * ADS extension — NASA Astrophysics Data System tools for agent-sh.
 *
 * Provides four tools:
 *   - ads_search:       Search ADS for papers
 *   - ads_paper:        Fetch details of a specific paper by bibcode/DOI/arXiv ID
 *   - ads_citations:    Find citing or referenced papers
 *   - ads_download_pdf: Download paper PDFs
 *
 * Requires: ADS_API_TOKEN environment variable
 *   Get one at https://ui.adsabs.harvard.edu/#user/settings/token
 *
 * Configuration (~/.agent-sh/settings.json):
 *   {
 *     "ads": { "pdfDownloadDir": "~/papers" }
 *   }
 */
import type { AgentContext } from "agent-sh/types";
import * as path from "path";
import * as fs from "fs/promises";
import { homedir } from "os";
import { fileURLToPath } from "url";

// ── Constants ────────────────────────────────────────────────────────

const ADS_SEARCH_API = "https://api.adsabs.harvard.edu/v1/search/query";
const ADS_EXPORT_API = "https://api.adsabs.harvard.edu/v1/export";
const ADS_LINK_GATEWAY = "https://ui.adsabs.harvard.edu/link_gateway";

const SEARCH_FIELDS = [
  "bibcode", "title", "author", "abstract", "pubdate", "year",
  "citation_count", "read_count", "doi", "identifier", "pub",
  "arxiv_class", "keyword", "database", "doctype", "aff",
  "volume", "issue", "page", "bibstem",
].join(",");

const PDF_SOURCES = {
  publisher: "PUB_PDF",
  ads: "ADS_PDF",
  arxiv: "EPRINT_PDF",
} as const;

type PDFSource = keyof typeof PDF_SOURCES;

const PDF_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36";

// ── Types ────────────────────────────────────────────────────────────

interface ADSPaper {
  bibcode: string;
  title: string;
  authors: string[];
  affiliations: string[];
  abstract: string;
  pubdate: string;
  year: string;
  citationCount: number;
  readCount: number;
  doi: string[];
  identifier: string[];
  pub: string;
  bibstem: string;
  volume: string;
  issue: string;
  page: string;
  arxivClass: string[];
  keywords: string[];
  database: string[];
  doctype: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseDoc(doc: any): ADSPaper {
  return {
    bibcode: doc.bibcode ?? "",
    title: Array.isArray(doc.title) ? doc.title.join(" ") : (doc.title ?? ""),
    authors: Array.isArray(doc.author) ? doc.author : doc.author ? [doc.author] : [],
    affiliations: Array.isArray(doc.aff) ? doc.aff : doc.aff ? [doc.aff] : [],
    abstract: doc.abstract ?? "",
    pubdate: doc.pubdate ?? "",
    year: doc.year ?? "",
    citationCount: doc.citation_count ?? 0,
    readCount: doc.read_count ?? 0,
    doi: Array.isArray(doc.doi) ? doc.doi : doc.doi ? [doc.doi] : [],
    identifier: Array.isArray(doc.identifier) ? doc.identifier : doc.identifier ? [doc.identifier] : [],
    pub: doc.pub ?? "",
    bibstem: Array.isArray(doc.bibstem) ? doc.bibstem[0] ?? "" : (doc.bibstem ?? ""),
    volume: doc.volume ?? "",
    issue: doc.issue ?? "",
    page: doc.page ?? "",
    arxivClass: Array.isArray(doc.arxiv_class) ? doc.arxiv_class : doc.arxiv_class ? [doc.arxiv_class] : [],
    keywords: Array.isArray(doc.keyword) ? doc.keyword : doc.keyword ? [doc.keyword] : [],
    database: Array.isArray(doc.database) ? doc.database : doc.database ? [doc.database] : [],
    doctype: doc.doctype ?? "",
  };
}

function truncateAuthors(authors: string[], maxAuthors = 10): string {
  if (authors.length <= maxAuthors) return authors.join("; ");
  return `${authors.slice(0, maxAuthors).join("; ")}; ... +${authors.length - maxAuthors} more`;
}

function formatPaper(p: ADSPaper, index?: number): string {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";
  const lines: string[] = [
    `${prefix}${p.title}`,
    `    Bibcode: ${p.bibcode}`,
    `    Authors: ${truncateAuthors(p.authors)}`,
    `    Published: ${p.pubdate}  Year: ${p.year}`,
    `    Journal: ${p.pub}`,
  ];
  if (p.doi.length > 0) lines.push(`    DOI: ${p.doi.join(", ")}`);
  if (p.arxivClass.length > 0) lines.push(`    arXiv: ${p.arxivClass.join(", ")}`);
  if (p.keywords.length > 0) lines.push(`    Keywords: ${p.keywords.slice(0, 10).join(", ")}`);
  lines.push(`    Citations: ${p.citationCount}  Reads: ${p.readCount}`);
  lines.push(`    ADS URL: ${ADS_LINK_GATEWAY}/${p.bibcode}`);
  if (p.abstract) lines.push(`    Abstract: ${p.abstract}`);
  return lines.join("\n");
}

function formatPaperCompact(p: ADSPaper, index?: number): string {
  const prefix = index !== undefined ? `[${index + 1}] ` : "";
  const authorStr = p.authors.length > 0
    ? p.authors.length === 1 ? p.authors[0] : `${p.authors[0]} et al.`
    : "Unknown";
  return `${prefix}${p.title}\n    ${p.bibcode} | ${authorStr} | ${p.year} | ${p.bibstem || p.pub} | ${p.citationCount} cit`;
}

function getToken(): string {
  const token = process.env.ADS_API_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "ADS_API_TOKEN environment variable not set. " +
      "Get a token from https://ui.adsabs.harvard.edu/#user/settings/token"
    );
  }
  return token;
}

async function adsFetch(url: string, options?: RequestInit): Promise<any> {
  const token = getToken();
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ADS API error: ${resp.status} ${resp.statusText}${body ? ` - ${body}` : ""}`);
  }
  return resp.json();
}

function buildIdQuery(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("10.") || trimmed.startsWith("doi:")) {
    return `doi:"${trimmed.replace(/^doi:/, "")}"`;
  } else if (trimmed.toLowerCase().startsWith("arxiv:") || /^\d{4}\.\d{4,5}/.test(trimmed)) {
    return `arxiv:"${trimmed.replace(/^arxiv:/i, "")}"`;
  }
  return `bibcode:${trimmed}`;
}

async function resolveBibcode(id: string): Promise<{ bibcode: string; title: string }> {
  const query = buildIdQuery(id);
  const url = `${ADS_SEARCH_API}?q=${encodeURIComponent(query)}&fl=bibcode,title&rows=1`;
  const data = await adsFetch(url);
  const docs: any[] = (data.response ?? data).docs ?? [];
  if (docs.length === 0) throw new Error(`Paper not found: ${id}`);
  return {
    bibcode: docs[0].bibcode ?? "",
    title: Array.isArray(docs[0].title) ? docs[0].title.join(" ") : (docs[0].title ?? ""),
  };
}

function buildSortParam(sortBy: string): string {
  const map: Record<string, string> = {
    relevance: "score desc",
    date: "date desc",
    citation_count: "citation_count desc",
    read_count: "read_count desc",
  };
  return map[sortBy] ?? "score desc";
}

function isBibcode(id: string): boolean {
  return /^\d{4}.{15}$/.test(id);
}

function bibcodeToFilename(bibcode: string): string {
  return bibcode.replace(/\./g, "_");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function getPdfDownloadDir(): Promise<string> {
  const settingsPath = path.join(homedir(), ".agent-sh", "settings.json");
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const dir = settings?.ads?.pdfDownloadDir;
    if (typeof dir === "string" && dir.length > 0) {
      return dir.replace(/^~/, homedir());
    }
  } catch { /* settings may not exist */ }
  // Default: ~/.agent-sh/papers
  return path.join(homedir(), ".agent-sh", "papers");
}

async function fetchPDF(bibcode: string, sourceKey: PDFSource): Promise<ArrayBuffer> {
  const url = `${ADS_LINK_GATEWAY}/${encodeURIComponent(bibcode)}/${PDF_SOURCES[sourceKey]}`;
  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": PDF_UA },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${sourceKey} source`);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const body = await resp.text();
    if (body.includes("CAPTCHA")) {
      throw new Error(`CAPTCHA detected from ${sourceKey} source. Try a different source.`);
    }
    throw new Error(`Expected PDF but got HTML from ${sourceKey} source. The paper may be behind a paywall. Try source='arxiv'.`);
  }
  if (!contentType.includes("application/pdf")) {
    throw new Error(`Unexpected Content-Type '${contentType}' from ${sourceKey} source.`);
  }

  return resp.arrayBuffer();
}

// ── Extension entry point ────────────────────────────────────────────

export default function activate(ctx: AgentContext): void {
  // Register the ADS query syntax skill — grouped with our tools in the system prompt
  const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "SKILL.md");
  ctx.agent.registerSkill(
    "ads",
    "Full ADS query syntax reference and search strategy. Load before composing ADS queries — the tool descriptions only cover basic field prefixes.",
    skillPath,
  );

  // ── ads_search ─────────────────────────────────────────────────────

  ctx.agent.registerTool({
    name: "ads_search",
    displayName: "search",
    description:
      "Search astronomy/physics papers (ADS) — preferred over web_search for literature queries.\n" +
      "Supports fielded syntax (title:, author:, year:, bibcode:, doi:), database filters, sort options.\n" +
      "⚠️ Load the ads skill BEFORE using this tool for advanced syntax and search strategies.\n" +
      "Requires ADS_API_TOKEN.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query. Supports fielded searches like "title:exoplanets", ' +
            '"author:\\"Hubble, E\\"", "keyword:dark matter", "year:2023". ' +
            'Unfielded terms search all metadata. Use quotes for phrases, +/- for inclusion/exclusion.',
        },
        database: {
          type: "string",
          enum: ["astronomy", "physics", "general"],
          description: "Filter by ADS database. Default: searches all databases.",
        },
        doctype: {
          type: "string",
          enum: ["article", "eprint", "inproceedings", "proceedings", "inbook", "book", "phdthesis", "mastersthesis", "catalog", "software", "proposal"],
          description: "Filter by document type.",
        },
        refereed: {
          type: "boolean",
          description: "Filter to only refereed (peer-reviewed) papers.",
        },
        year_from: {
          type: "string",
          description: "Start year for date range filter, e.g. '2020'.",
        },
        year_to: {
          type: "string",
          description: "End year for date range filter, e.g. '2024'.",
        },
        max_results: {
          type: "number",
          description: "Max papers to return (default 10, max 50).",
        },
        sort_by: {
          type: "string",
          enum: ["relevance", "date", "citation_count", "read_count"],
          description: "Sort order (default: relevance).",
        },
        start: {
          type: "number",
          description: "Start index for pagination (default 0).",
        },
        detail: {
          type: "string",
          enum: ["compact", "full"],
          description: "Output detail level. 'compact' (default): title, first author, year, bibcode, citations. 'full': includes abstract, all authors, keywords, DOI.",
        },
      },
      required: ["query"],
    },

    async execute(args) {
      const query = args.query as string;
      const maxResults = Math.min((args.max_results as number) ?? 10, 50);
      const start = (args.start as number) ?? 0;
      const sort = buildSortParam((args.sort_by as string) ?? "relevance");
      const detail = (args.detail as string) ?? "compact";

      const fq: string[] = [];
      if (args.database) fq.push(`database:${args.database}`);
      if (args.doctype) fq.push(`doctype:${args.doctype}`);
      if (args.refereed) fq.push("property:refereed");
      if (args.year_from || args.year_to) {
        fq.push(`year:[${args.year_from ?? "*"} TO ${args.year_to ?? "*"}]`);
      }

      const fqParam = fq.map(f => `&fq=${encodeURIComponent(f)}`).join("");
      const url =
        `${ADS_SEARCH_API}?q=${encodeURIComponent(query)}` +
        `&fl=${SEARCH_FIELDS}&rows=${maxResults}&start=${start}` +
        `&sort=${encodeURIComponent(sort)}${fqParam}`;

      const data = await adsFetch(url);
      const response = data.response ?? data;
      const docs: any[] = response.docs ?? [];
      const totalResults = response.numFound ?? 0;

      if (docs.length === 0) {
        return { content: `No papers found for query: ${query}`, exitCode: 0, isError: false };
      }

      const papers = docs.map(parseDoc);
      const formatter = detail === "full" ? formatPaper : formatPaperCompact;
      let text = `Found ${totalResults} papers (showing ${start + 1}-${start + papers.length}):\n`;
      text += papers.map((p, i) => formatter(p, i)).join("\n\n");

      const nextStart = start + papers.length;
      if (nextStart < totalResults) {
        text += `\n\n→ Use start=${nextStart} to see the next page of results.`;
      }

      return { content: text, exitCode: 0, isError: false };
    },

    getDisplayInfo(args) {
      return { kind: "search" };
    },

    formatCall(args) {
      const parts: string[] = [];
      if (args.query) parts.push(String(args.query));
      if (args.year_from || args.year_to) parts.push(`${args.year_from ?? "*"}–${args.year_to ?? "*"}`);
      if (args.database) parts.push(`db:${args.database}`);
      if (args.sort_by && args.sort_by !== "relevance") parts.push(`sort:${args.sort_by}`);
      return parts.join("  ");
    },
  });

  // ── ads_paper ──────────────────────────────────────────────────────

  ctx.agent.registerTool({
    name: "ads_paper",
    displayName: "paper",
    description:
      "Fetch a paper's details from ADS by bibcode, DOI, or arXiv ID.\n" +
      "Optional BibTeX return. ⚠️ Load the ads skill BEFORE using for field syntax help.\n" +
      "Requires ADS_API_TOKEN.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            'Paper identifier: ADS bibcode (e.g. "2023ApJ...950L..12A"), ' +
            'DOI (e.g. "10.3847/2041-8213/acb7e0"), or arXiv ID (e.g. "arXiv:2301.01234").',
        },
        bibtex: {
          type: "boolean",
          description: "Include BibTeX citation (default: false).",
        },
      },
      required: ["id"],
    },

    async execute(args) {
      const id = (args.id as string).trim();
      const query = buildIdQuery(id);
      const url = `${ADS_SEARCH_API}?q=${encodeURIComponent(query)}&fl=${SEARCH_FIELDS}&rows=1`;

      const data = await adsFetch(url);
      const docs: any[] = (data.response ?? data).docs ?? [];

      if (docs.length === 0) {
        return { content: `Paper not found: ${id}`, exitCode: 1, isError: true };
      }

      const paper = parseDoc(docs[0]);
      let text = formatPaper(paper);

      if (args.bibtex && paper.bibcode) {
        try {
          const exportData = await adsFetch(`${ADS_EXPORT_API}/bibtex`, {
            method: "POST",
            body: JSON.stringify({ bibcode: [paper.bibcode] }),
          });
          const bibtex = exportData.export ?? "";
          if (bibtex) text += `\n\nBibTeX:\n${bibtex}`;
        } catch {
          text += "\n\n[Failed to fetch BibTeX]";
        }
      }

      return { content: text, exitCode: 0, isError: false };
    },

    getDisplayInfo(args) {
      return { kind: "read" };
    },

    formatCall(args) {
      return String(args.id ?? "");
    },
  });

  // ── ads_citations ──────────────────────────────────────────────────

  ctx.agent.registerTool({
    name: "ads_citations",
    displayName: "citations",
    description:
      "List citations or references of an ADS bibcode.\n" +
      "detail='compact'|'full'. ⚠️ Load the ads skill BEFORE using for syntax help.\n" +
      "Requires ADS_API_TOKEN.",
    input_schema: {
      type: "object",
      properties: {
        bibcode: {
          type: "string",
          description: 'ADS bibcode of the paper, e.g. "2023ApJ...950L..12A".',
        },
        direction: {
          type: "string",
          enum: ["citations", "references"],
          description: '"citations" = papers that cite this paper (default). "references" = papers this paper cites.',
        },
        max_results: {
          type: "number",
          description: "Max papers to return (default 10, max 50).",
        },
        sort_by: {
          type: "string",
          enum: ["date", "citation_count", "read_count"],
          description: "Sort order (default: date).",
        },
        start: {
          type: "number",
          description: "Start index for pagination (default 0).",
        },
        detail: {
          type: "string",
          enum: ["compact", "full"],
          description: "Output detail level. 'compact' (default) or 'full' with abstracts.",
        },
      },
      required: ["bibcode"],
    },

    async execute(args) {
      const bibcode = args.bibcode as string;
      const direction = (args.direction as string) ?? "citations";
      const maxResults = Math.min((args.max_results as number) ?? 10, 50);
      const start = (args.start as number) ?? 0;
      const sort = buildSortParam((args.sort_by as string) ?? "date");
      const detail = (args.detail as string) ?? "compact";

      const queryFunc = direction === "citations" ? "citations" : "references";
      const query = `${queryFunc}(${bibcode})`;

      const url =
        `${ADS_SEARCH_API}?q=${encodeURIComponent(query)}` +
        `&fl=${SEARCH_FIELDS}&rows=${maxResults}&start=${start}` +
        `&sort=${encodeURIComponent(sort)}`;

      const data = await adsFetch(url);
      const response = data.response ?? data;
      const docs: any[] = response.docs ?? [];
      const totalResults = response.numFound ?? 0;

      if (docs.length === 0) {
        const label = direction === "citations" ? "citing" : "referenced by";
        return { content: `No papers ${label} ${bibcode}`, exitCode: 0, isError: false };
      }

      const papers = docs.map(parseDoc);
      const formatter = detail === "full" ? formatPaper : formatPaperCompact;
      const dirLabel = direction === "citations" ? "citing papers" : "referenced papers";
      let text = `Found ${totalResults} ${dirLabel} (showing ${start + 1}-${start + papers.length}):\n`;
      text += papers.map((p, i) => formatter(p, i)).join("\n\n");

      const nextStart = start + papers.length;
      if (nextStart < totalResults) {
        text += `\n\n→ Use start=${nextStart} to see the next page of results.`;
      }

      return { content: text, exitCode: 0, isError: false };
    },

    getDisplayInfo(args) {
      return { kind: "search" };
    },

    formatCall(args) {
      const dir = (args.direction as string) ?? "citations";
      return `${args.bibcode} ${dir}`;
    },
  });

  // ── ads_download_pdf ───────────────────────────────────────────────

  ctx.agent.registerTool({
    name: "ads_download_pdf",
    displayName: "download",
    description:
      "Download a paper's PDF (bibcode/DOI/arXiv ID).\n" +
      "Fallback: publisher → ADS → arXiv. ⚠️ Load the ads skill BEFORE using.\n" +
      "Requires ADS_API_TOKEN.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            'Paper identifier: ADS bibcode (e.g. "2023ApJ...950L..12A"), ' +
            'DOI (e.g. "10.3847/2041-8213/acb7e0"), or arXiv ID (e.g. "arXiv:2301.01234").',
        },
        output_path: {
          type: "string",
          description:
            "File path to save the PDF. Defaults to ~/.agent-sh/papers/{bibcode}.pdf. " +
            "If a directory path is given, saves as {dir}/{bibcode}.pdf.",
        },
        source: {
          type: "string",
          enum: ["auto", "publisher", "ads", "arxiv"],
          description:
            "Preferred PDF source. 'auto' (default) tries publisher → ADS → arXiv. " +
            "'publisher' = PUB_PDF, 'ads' = ADS_PDF, 'arxiv' = EPRINT_PDF.",
        },
      },
      required: ["id"],
    },
    modifiesFiles: true,

    async execute(args) {
      const sourceParam = (args.source as string) ?? "auto";
      const trimmedId = (args.id as string).trim();
      const idIsBibcode = isBibcode(trimmedId);
      const downloadDir = await getPdfDownloadDir();

      // Fast path: check if already downloaded (bibcode only)
      if (!args.output_path && idIsBibcode) {
        const candidatePath = downloadDir
          ? path.join(downloadDir, `${bibcodeToFilename(trimmedId)}.pdf`)
          : path.join(process.cwd(), `${bibcodeToFilename(trimmedId)}.pdf`);

        try {
          const stat = await fs.stat(candidatePath);
          return {
            content:
              `PDF already exists: ${candidatePath}\n` +
              `  Bibcode: ${trimmedId}\n` +
              `  Size: ${formatFileSize(stat.size)}\n` +
              `  Modified: ${stat.mtime.toISOString()}\n\n` +
              `To re-download, delete the file first or specify a different output_path.`,
            exitCode: 0,
            isError: false,
          };
        } catch { /* not cached, continue */ }
      }

      // Resolve identifier to bibcode
      let resolved: { bibcode: string; title: string };
      try {
        resolved = await resolveBibcode(args.id as string);
      } catch {
        return { content: `Paper not found: ${args.id}`, exitCode: 1, isError: true };
      }

      const { bibcode, title } = resolved;
      const safeName = `${bibcodeToFilename(bibcode)}.pdf`;

      let outputPath: string;
      if (!args.output_path) {
        outputPath = downloadDir
          ? path.join(downloadDir, safeName)
          : path.join(process.cwd(), safeName);
      } else {
        const op = args.output_path as string;
        outputPath = (op.endsWith("/") || !path.extname(op))
          ? path.join(op, safeName)
          : op;
      }

      // Check if already exists (post-resolution)
      try {
        const stat = await fs.stat(outputPath);
        return {
          content:
            `PDF already exists: ${outputPath}\n` +
            `  Bibcode: ${bibcode}\n` +
            `  Title: ${title}\n` +
            `  Size: ${formatFileSize(stat.size)}\n` +
            `  Modified: ${stat.mtime.toISOString()}\n\n` +
            `To re-download, delete the file first or specify a different output_path.`,
          exitCode: 0,
          isError: false,
        };
      } catch { /* proceed with download */ }

      // Try sources in order
      const sourceOrder: PDFSource[] =
        sourceParam === "auto"
          ? ["publisher", "ads", "arxiv"]
          : [sourceParam as PDFSource];

      let pdfBuffer: ArrayBuffer | undefined;
      let usedSource: PDFSource | undefined;
      let lastError = "";

      for (const src of sourceOrder) {
        try {
          pdfBuffer = await fetchPDF(bibcode, src);
          usedSource = src;
          break;
        } catch (err: any) {
          lastError = err.message ?? String(err);
        }
      }

      if (!pdfBuffer || !usedSource) {
        return {
          content:
            `Failed to download PDF for ${bibcode} (${title}).\n` +
            `Tried sources: ${sourceOrder.join(" → ")}.\n` +
            `Last error: ${lastError}\n\n` +
            `Try downloading manually: ${ADS_LINK_GATEWAY}/${bibcode}/EPRINT_PDF`,
          exitCode: 1,
          isError: true,
        };
      }

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from(pdfBuffer));

      const sourceLabel = { publisher: "publisher", ads: "ADS", arxiv: "arXiv" }[usedSource];
      return {
        content:
          `Downloaded PDF for: ${title}\n` +
          `  Bibcode: ${bibcode}\n` +
          `  Source: ${sourceLabel}\n` +
          `  Saved to: ${outputPath}\n` +
          `  Size: ${formatFileSize(pdfBuffer.byteLength)}`,
        exitCode: 0,
        isError: false,
      };
    },

    getDisplayInfo(args) {
      return { kind: "write" };
    },

    formatCall(args) {
      return String(args.id ?? "");
    },
  });
}
