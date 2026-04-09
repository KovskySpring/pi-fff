/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Overrides the built-in `find` and `grep` tools with FFF (Fast File Finder),
 * a Rust-native fuzzy file finder with frecency ranking, git awareness,
 * and SIMD-accelerated content search.
 *
 * Also adds a `multi_grep` tool for OR-logic multi-pattern search.
 *
 * Usage:
 *   Add to settings.json extensions or ~/.pi/agent/extensions/
 *   Or test with: pi -e /path/to/pi-fff/src/index.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, truncateHead, DEFAULT_MAX_BYTES, formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { FileFinder } from "@ff-labs/fff-node";
import type {
	GrepCursor,
	GrepResult,
	SearchResult,
	GrepMode,
} from "@ff-labs/fff-node";
import { join } from "path";
import { mkdirSync } from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FFF_DB_DIR = join(getAgentDir(), "fff");
const FRECENCY_DB_PATH = join(FFF_DB_DIR, "frecency.mdb");
const HISTORY_DB_PATH = join(FFF_DB_DIR, "history.mdb");
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 200;
const GREP_MAX_LINE_LENGTH = 500;

// ---------------------------------------------------------------------------
// Cursor store — maps opaque IDs to GrepCursor values across tool calls
// ---------------------------------------------------------------------------

class CursorStore {
	private cursors = new Map<string, GrepCursor>();
	private counter = 0;

	store(cursor: GrepCursor): string {
		const id = `fff_c${++this.counter}`;
		this.cursors.set(id, cursor);
		// Evict old entries to bound memory
		if (this.cursors.size > 200) {
			const first = this.cursors.keys().next().value;
			if (first) this.cursors.delete(first);
		}
		return id;
	}

	get(id: string): GrepCursor | undefined {
		return this.cursors.get(id);
	}
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}...`;
}

function formatGrepOutput(result: GrepResult, limit: number): string {
	const items = result.items.slice(0, limit);
	if (items.length === 0) return "No matches found";

	const lines: string[] = [];
	let currentFile = "";

	for (const match of items) {
		if (match.relativePath !== currentFile) {
			currentFile = match.relativePath;
			// Blank line between files for readability
			if (lines.length > 0) lines.push("");
		}

		// Context before
		if (match.contextBefore && match.contextBefore.length > 0) {
			const startLine = match.lineNumber - match.contextBefore.length;
			for (let i = 0; i < match.contextBefore.length; i++) {
				lines.push(`${match.relativePath}-${startLine + i}- ${truncateLine(match.contextBefore[i])}`);
			}
		}

		// Match line
		lines.push(`${match.relativePath}:${match.lineNumber}: ${truncateLine(match.lineContent)}`);

		// Context after
		if (match.contextAfter && match.contextAfter.length > 0) {
			const startLine = match.lineNumber + 1;
			for (let i = 0; i < match.contextAfter.length; i++) {
				lines.push(`${match.relativePath}-${startLine + i}- ${truncateLine(match.contextAfter[i])}`);
			}
		}
	}

	return lines.join("\n");
}

function formatFindOutput(result: SearchResult, limit: number): string {
	const items = result.items.slice(0, limit);
	if (items.length === 0) return "No files found matching pattern";
	return items.map((item) => item.relativePath).join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI) {
	let finder: FileFinder | null = null;
	const cursorStore = new CursorStore();

	// Ensure DB directory exists
	try {
		mkdirSync(FFF_DB_DIR, { recursive: true });
	} catch {
		// ignore
	}

	async function ensureFinder(cwd: string): Promise<FileFinder> {
		if (finder && !finder.isDestroyed) return finder;

		const result = FileFinder.create({
			basePath: cwd,
			frecencyDbPath: FRECENCY_DB_PATH,
			historyDbPath: HISTORY_DB_PATH,
			aiMode: true,
		});

		if (!result.ok) {
			throw new Error(`Failed to create FFF file finder: ${result.error}`);
		}

		finder = result.value;
		const scanResult = await finder.waitForScan(15000);
		if (scanResult.ok && !scanResult.value) {
			// Timed out but still usable — partial index
		}

		return finder;
	}

	function destroyFinder() {
		if (finder && !finder.isDestroyed) {
			finder.destroy();
			finder = null;
		}
	}

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureFinder(ctx.cwd);
			ctx.ui.setStatus("fff", "FFF indexed");
			// Clear status after a moment
			setTimeout(() => ctx.ui.setStatus("fff", undefined), 3000);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			ctx.ui.notify(`FFF init failed: ${msg}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		destroyFinder();
	});

	// --- grep tool (overrides built-in) ---

	const grepSchema = Type.Object({
		pattern: Type.String({ description: "Search pattern (plain text or regex)" }),
		constraint: Type.Optional(
			Type.String({ description: "Path file constraint, e.g. 'src/' or '*.ts' (default: project root)" }),
		),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: smart case)" })),
		literal: Type.Optional(
			Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: true)" }),
		),
		context: Type.Optional(
			Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
		),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})` }),
		),
		cursor: Type.Optional(Type.String({ description: "Cursor from previous result for pagination" })),
	});

	pi.registerTool({
		name: "grep",
		label: "grep (fff)",
		description: [
			`Search file contents for a pattern using FFF (fast, frecency-ranked, git-aware).`,
			`Returns matching lines with file paths and line numbers. Respects .gitignore.`,
			`Supports plain text, regex, and fuzzy search modes. Smart case by default.`,
			`Output truncated to ${DEFAULT_GREP_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		].join(" "),
		promptSnippet: "Search file contents for patterns (FFF: frecency-ranked, git-aware, respects .gitignore)",
		promptGuidelines: [
			"Search for bare identifiers (e.g. 'InProgressQuote'), not code syntax or multi-token regex.",
			"Plain text search is faster and more reliable than regex. Prefer it.",
			"After 2 grep calls, read the top result file instead of grepping more.",
      "Use the constraint parameter for file/directory constraints: '*.ts', 'src/'.",
			"The constraint parameter does not support relative paths. Directories has to include trailing slash, e.g. 'src/'",
		],
		parameters: grepSchema,

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const f = await ensureFinder(process.cwd());
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

			// Build query: prepend path constraint if provided
			let query = params.pattern;
			if (params.constraint) {
				query = `${params.constraint} ${query}`;
			}

			// Determine mode
			const isLiteral = params.literal !== false;
			let mode: GrepMode = "plain";
			if (!isLiteral) {
				mode = "regex";
			}

			// Resolve cursor
			const prevCursor = params.cursor ? cursorStore.get(params.cursor) : undefined;

			const grepResult = f.grep(query, {
				mode,
				smartCase: params.ignoreCase === true ? false : true,
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				cursor: prevCursor ?? null,
				beforeContext: params.context ?? 0,
				afterContext: params.context ?? 0,
			});

			if (!grepResult.ok) {
				throw new Error(grepResult.error);
			}

			const result = grepResult.value;
			let output = formatGrepOutput(result, effectiveLimit);

			// Apply byte truncation
			const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
			output = truncation.content;

			// Build notices
			const notices: string[] = [];
			if (result.items.length >= effectiveLimit) {
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more`);
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (result.regexFallbackError) {
				notices.push(`Regex failed: ${result.regexFallbackError}, used literal match`);
			}

			// Pagination cursor
			if (result.nextCursor) {
				const cursorId = cursorStore.store(result.nextCursor);
				notices.push(`More results available. Use cursor="${cursorId}" to continue`);
			}

			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					truncated: truncation.truncated,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const pattern = args?.pattern ?? "";
			const path = args?.constraint ?? ".";
			let content =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				theme.fg("accent", `/${pattern}/`) +
				theme.fg("toolOutput", ` in ${path}`);
			if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
			if (args?.cursor) content += theme.fg("muted", ` (page)`);
			text.setText(content);
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const textContent = result.content?.find(
				(c: { type: string; text?: string }) => c.type === "text",
			) as { type: string; text?: string } | undefined;
			const output = textContent?.text?.trim() ?? "";

			if (!output) {
				text.setText(theme.fg("muted", "No output"));
				return text;
			}

			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 15;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
			if (remaining > 0) {
				content += theme.fg("muted", `\n... (${remaining} more lines)`);
			}
			text.setText(content);
			return text;
		},
	});

	// --- find tool (overrides built-in) ---

	const findSchema = Type.Object({
		pattern: Type.String({
			description: "Fuzzy search query for file names. Supports path prefixes ('src/') and globs ('*.ts').",
		}),
		constraint: Type.Optional(Type.String({ description: "Directory to search in (default: project root)" })),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of results (default: ${DEFAULT_FIND_LIMIT})` }),
		),
	});

	pi.registerTool({
		name: "find",
		label: "find (fff)",
		description: [
			`Fuzzy file search by name using FFF (fast, frecency-ranked, git-aware).`,
			`Returns matching file paths relative to project root. Respects .gitignore.`,
			`Supports fuzzy matching, path prefixes ('src/'), and glob constraints ('*.ts', '**/*.spec.ts').`,
			`Output truncated to ${DEFAULT_FIND_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		].join(" "),
		promptSnippet: "Find files by name (FFF: fuzzy, frecency-ranked, git-aware, respects .gitignore)",
		promptGuidelines: [
			"Keep queries short -- prefer 1-2 terms max.",
			"Multiple words narrow results (waterfall), they are not OR.",
      "Use this to find files by name. Use grep to search file contents.",
			"The constraint parameter does not support relative paths. Directories has to include trailing slash, e.g. 'src/'",
		],
		parameters: findSchema,

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const f = await ensureFinder(process.cwd());
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);

			// Build query: prepend path constraint if provided
			let query = params.pattern;
			if (params.constraint) {
				query = `${params.constraint} ${query}`;
			}

			const searchResult = f.fileSearch(query, {
				pageSize: effectiveLimit,
			});

			if (!searchResult.ok) {
				throw new Error(searchResult.error);
			}

			const result = searchResult.value;
			let output = formatFindOutput(result, effectiveLimit);

			// Apply byte truncation
			const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
			output = truncation.content;

			// Build notices
			const notices: string[] = [];
			if (result.items.length >= effectiveLimit) {
				notices.push(
					`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (result.totalMatched > result.items.length) {
				notices.push(`${result.totalMatched} total matches (${result.totalFiles} indexed files)`);
			}

			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					truncated: truncation.truncated,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const pattern = args?.pattern ?? "";
			const path = args?.constraint ?? ".";
			let content =
				theme.fg("toolTitle", theme.bold("find")) +
				" " +
				theme.fg("accent", pattern) +
				theme.fg("toolOutput", ` in ${path}`);
			if (args?.limit !== undefined) content += theme.fg("toolOutput", ` (limit ${args.limit})`);
			text.setText(content);
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const textContent = result.content?.find(
				(c: { type: string; text?: string }) => c.type === "text",
			) as { type: string; text?: string } | undefined;
			const output = textContent?.text?.trim() ?? "";

			if (!output) {
				text.setText(theme.fg("muted", "No output"));
				return text;
			}

			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 20;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
			if (remaining > 0) {
				content += theme.fg("muted", `\n... (${remaining} more lines)`);
			}
			text.setText(content);
			return text;
		},
	});

	// --- multi_grep tool (new, no built-in equivalent) ---

	const multiGrepSchema = Type.Object({
		patterns: Type.Array(Type.String(), {
			description:
				"Patterns to search for (OR logic -- matches lines containing ANY pattern). Include all naming conventions: snake_case, PascalCase, camelCase.",
		}),
		constraints: Type.Optional(
			Type.String({
				description: "File constraints, e.g. '*.{ts,tsx} !test/' to filter files. Separate from patterns.",
			}),
		),
		context: Type.Optional(
			Type.Number({ description: "Number of context lines before and after each match (default: 0)" }),
		),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})` }),
		),
		cursor: Type.Optional(Type.String({ description: "Cursor from previous result for pagination" })),
	});

	pi.registerTool({
		name: "multi_grep",
		label: "multi_grep (fff)",
		description: [
			`Search file contents for lines matching ANY of multiple patterns (OR logic).`,
			`Uses SIMD-accelerated Aho-Corasick multi-pattern matching. Faster than regex alternation.`,
			`Patterns are literal text -- never escape special characters.`,
			`Use the constraints parameter for file filtering ('*.rs', 'src/', '!test/').`,
		].join(" "),
		promptSnippet:
			"Multi-pattern OR search across file contents (FFF: SIMD-accelerated, frecency-ranked)",
		promptGuidelines: [
			"Use multi_grep when you need to find multiple identifiers at once (OR logic).",
			"Include all naming conventions: snake_case, PascalCase, camelCase variants.",
			"Patterns are literal text. Never escape special characters.",
      "Use the constraints parameter for file type/path filtering, not inside patterns.",
			"The constraints parameter does not support relative paths. Directories has to include trailing slash, e.g. 'src/'",
		],
		parameters: multiGrepSchema,

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			if (!params.patterns || params.patterns.length === 0) {
				throw new Error("patterns array must have at least 1 element");
			}

			const f = await ensureFinder(process.cwd());
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

			// Resolve cursor
			const prevCursor = params.cursor ? cursorStore.get(params.cursor) : undefined;

			const grepResult = f.multiGrep({
				patterns: params.patterns,
				constraints: params.constraints,
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				smartCase: true,
				cursor: prevCursor ?? null,
				beforeContext: params.context ?? 0,
				afterContext: params.context ?? 0,
			});

			if (!grepResult.ok) {
				throw new Error(grepResult.error);
			}

			const result = grepResult.value;
			let output = formatGrepOutput(result, effectiveLimit);

			// Apply byte truncation
			const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
			output = truncation.content;

			// Build notices
			const notices: string[] = [];
			if (result.items.length >= effectiveLimit) {
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more`);
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (result.nextCursor) {
				const cursorId = cursorStore.store(result.nextCursor);
				notices.push(`More results available. Use cursor="${cursorId}" to continue`);
			}

			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					truncated: truncation.truncated,
					patterns: params.patterns,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const patterns = args?.patterns ?? [];
			const constraints = args?.constraints;
			let content =
				theme.fg("toolTitle", theme.bold("multi_grep")) +
				" " +
				theme.fg("accent", patterns.map((p: string) => `"${p}"`).join(", "));
			if (constraints) content += theme.fg("toolOutput", ` (${constraints})`);
			if (args?.cursor) content += theme.fg("muted", ` (page)`);
			text.setText(content);
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const textContent = result.content?.find(
				(c: { type: string; text?: string }) => c.type === "text",
			) as { type: string; text?: string } | undefined;
			const output = textContent?.text?.trim() ?? "";

			if (!output) {
				text.setText(theme.fg("muted", "No output"));
				return text;
			}

			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 15;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
			if (remaining > 0) {
				content += theme.fg("muted", `\n... (${remaining} more lines)`);
			}
			text.setText(content);
			return text;
		},
	});

	// --- /fff-health command ---

	pi.registerCommand("fff-health", {
		description: "Show FFF file finder health and status",
		handler: async (_args, ctx) => {
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const health = finder.healthCheck();
			if (!health.ok) {
				ctx.ui.notify(`Health check failed: ${health.error}`, "error");
				return;
			}

			const h = health.value;
			const lines = [
				`FFF v${h.version}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
			];

			const progress = finder.getScanProgress();
			if (progress.ok) {
				lines.push(`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// --- /fff-rescan command ---

	pi.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args, ctx) => {
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const result = finder.scanFiles();
			if (!result.ok) {
				ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
				return;
			}

			ctx.ui.notify("FFF rescan triggered", "info");
		},
	});
}
