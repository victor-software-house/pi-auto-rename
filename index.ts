import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model, Api, TextContent } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import {
	DynamicBorder,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	getEditorKeybindings,
	Input,
	type AutocompleteItem,
	type SelectItem,
	SelectList,
	Text,
} from "@mariozechner/pi-tui";
import { getConversationTranscript, getFirstUserMessageText, sanitizeSessionName } from "./utils.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-haiku-4-5";
const CUSTOM_ENTRY_TYPE = "pi-auto-rename-model";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-auto-rename.json");

const SYSTEM_PROMPT =
	"You create short, descriptive session names for chat sessions with AI. " +
	"Use 2-6 words in Title Case. Respond with only the name, no quotes or punctuation.";

const SUBCOMMANDS = ["model", "show", "reset", "help"];
const USAGE = "Usage: /rename [model [provider/model] | show | reset | help]";

// ─── Model config ─────────────────────────────────────────────────────────────

interface ModelRef {
	provider: string;
	id: string;
}

const defaultRef = (): ModelRef => ({ provider: DEFAULT_PROVIDER, id: DEFAULT_MODEL });

function formatRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

function parseRef(input: string): ModelRef | null {
	const trimmed = input.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

// ─── Config persistence ───────────────────────────────────────────────────────

function readConfigFile(): ModelRef | null {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof raw?.provider === "string" && typeof raw?.id === "string") {
			return { provider: raw.provider.trim(), id: raw.id.trim() };
		}
		return null;
	} catch {
		return null;
	}
}

function writeConfigFile(ref: ModelRef): boolean {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(ref, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

function readSessionConfig(ctx: ExtensionContext): ModelRef | null {
	for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
		if (entry.type !== "custom") continue;
		const custom = entry as CustomEntry<ModelRef>;
		if (custom.customType !== CUSTOM_ENTRY_TYPE || !custom.data) continue;
		const { provider, id } = custom.data;
		if (typeof provider === "string" && typeof id === "string") return { provider, id };
	}
	return null;
}

function loadConfig(ctx: ExtensionContext): ModelRef | null {
	const file = readConfigFile();
	if (file) return file;
	const session = readSessionConfig(ctx);
	if (session) writeConfigFile(session);
	return session;
}

// ─── Auth resolution ──────────────────────────────────────────────────────────

async function resolveAuth(
	ctx: ExtensionContext,
	ref: ModelRef,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string> } | null> {
	const model = ctx.modelRegistry.find(ref.provider, ref.id);
	if (!model) {
		notify(ctx, `Model not found: ${formatRef(ref)}`, "warning");
		return null;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		notify(ctx, `No auth for ${ref.provider}: ${auth.error}. Configure via /login or models.json.`, "warning");
		return null;
	}
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

// ─── Model picker ─────────────────────────────────────────────────────────────

async function openModelPicker(ctx: ExtensionCommandContext, current: ModelRef): Promise<ModelRef | null> {
	const available = ctx.modelRegistry
		.getAvailable()
		.map((m): ModelRef => ({ provider: m.provider, id: m.id }))
		.sort((a, b) => formatRef(a).localeCompare(formatRef(b)));

	if (available.length === 0) {
		notify(ctx, "No models with configured auth available.", "warning");
		return null;
	}
	if (!ctx.hasUI) {
		notify(ctx, "No interactive UI. Use: /rename model provider/model", "warning");
		return null;
	}

	return ctx.ui.custom<ModelRef | null>((tui, theme, _kb, done) => {
		const kb = getEditorKeybindings();
		const currentLabel = formatRef(current);
		const root = new Container();
		root.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		root.addChild(new Text(theme.fg("accent", theme.bold("Select Rename Model"))));
		root.addChild(new Text(theme.fg("muted", `Current: ${currentLabel}`)));
		root.addChild(new Text(theme.fg("muted", "Search:")));

		const search = new Input();
		root.addChild(search);

		const listBox = new Container();
		root.addChild(listBox);

		const toItems = (q: string): SelectItem[] => {
			const lq = q.toLowerCase();
			return available
				.filter((m) => !lq || formatRef(m).toLowerCase().includes(lq) || m.id.toLowerCase().includes(lq))
				.map((m) => ({ value: formatRef(m), label: m.id, description: m.provider }));
		};

		let list: SelectList;
		let lastValue: string | undefined = currentLabel;

		const rebuild = () => {
			const items = toItems(search.getValue().trim());
			const next = new SelectList(items, 10, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			next.onSelect = (item) => done(parseRef(item.value));
			next.onCancel = () => done(null);
			next.onSelectionChange = (item) => { lastValue = item.value; };
			const idx = lastValue ? items.findIndex((i) => i.value === lastValue) : -1;
			if (idx >= 0) next.setSelectedIndex(idx);
			list = next;
			listBox.clear();
			listBox.addChild(list);
		};

		rebuild();
		root.addChild(new Text(theme.fg("dim", "type to search | up/down navigate | enter select | esc cancel")));
		root.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render: (w: number) => root.render(w),
			invalidate: () => root.invalidate(),
			handleInput: (data: string) => {
				const isNav =
					kb.matches(data, "selectUp") ||
					kb.matches(data, "selectDown") ||
					kb.matches(data, "selectConfirm") ||
					kb.matches(data, "selectCancel");
				if (isNav) {
					list.handleInput(data);
					const sel = list.getSelectedItem();
					if (sel) lastValue = sel.value;
				} else {
					search.handleInput(data);
					rebuild();
				}
				tui.requestRender();
			},
		};
	});
}

// ─── Session naming ───────────────────────────────────────────────────────────

function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(msg, level);
}

async function generateName(ctx: ExtensionContext, ref: ModelRef, instruction: string, content: string): Promise<string | null> {
	const resolved = await resolveAuth(ctx, ref);
	if (!resolved) return null;

	try {
		const prompt = {
			role: "user" as const,
			content: [{ type: "text" as const, text: `${instruction}\n\n${content}` }] satisfies TextContent[],
			timestamp: Date.now(),
		};
		const response = await complete(
			resolved.model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [prompt] },
			{ apiKey: resolved.apiKey, headers: resolved.headers, maxTokens: 128 },
		);

		if (response.stopReason === "error") {
			notify(ctx, `Rename failed: ${response.errorMessage ?? "unknown error"}`, "warning");
			return null;
		}

		const raw = response.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n");

		return sanitizeSessionName(raw) || null;
	} catch (err) {
		notify(ctx, `Rename failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return null;
	}
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function piAutoRename(pi: ExtensionAPI) {
	let modelRef: ModelRef = readConfigFile() ?? defaultRef();
	let namingAttempted = false;
	let namingInProgress = false;
	let cachedModels: ModelRef[] = [];

	// ── Internal helpers ──────────────────────────────────────────────────

	function persist(ref: ModelRef): boolean {
		modelRef = ref;
		pi.appendEntry<ModelRef>(CUSTOM_ENTRY_TYPE, ref);
		return writeConfigFile(ref);
	}

	function restoreModel(ctx: ExtensionContext): void {
		modelRef = loadConfig(ctx) ?? defaultRef();
	}

	function refreshModelCache(ctx: ExtensionContext): void {
		cachedModels = ctx.modelRegistry.getAvailable().map((m): ModelRef => ({ provider: m.provider, id: m.id }));
	}

	function resetNaming(): void {
		namingAttempted = false;
		namingInProgress = false;
	}

	async function autoName(ctx: ExtensionContext): Promise<void> {
		if (namingAttempted || namingInProgress || pi.getSessionName()) return;

		const firstMsg = getFirstUserMessageText(ctx.sessionManager.getBranch());
		if (!firstMsg) return;

		namingAttempted = true;
		namingInProgress = true;
		try {
			const name = await generateName(
				ctx,
				modelRef,
				"Name this session based on the first user message. Use 2-6 words in Title Case.",
				`First user message:\n${firstMsg}`,
			);
			if (name && !pi.getSessionName()) pi.setSessionName(name);
		} finally {
			namingInProgress = false;
		}
	}

	function onSessionEvent(_event: unknown, ctx: ExtensionContext): void {
		resetNaming();
		restoreModel(ctx);
		refreshModelCache(ctx);
	}

	// ── /rename command ───────────────────────────────────────────────────

	pi.registerCommand("rename", {
		description: "Rename session with AI. Subcommands: model, show, reset, help.",

		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trimStart();

			if (!trimmed.includes(" ")) {
				const hits = SUBCOMMANDS.filter((s) => s.startsWith(trimmed));
				return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null;
			}

			const [sub, rest] = [trimmed.slice(0, trimmed.indexOf(" ")), trimmed.slice(trimmed.indexOf(" ") + 1)];
			if (sub !== "model") return null;

			const refs = cachedModels.map(formatRef).filter((r) => r.startsWith(rest));
			return refs.length > 0 ? refs.map((r) => ({ value: `model ${r}`, label: r })) : null;
		},

		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// No args: rename from full conversation history
			if (!trimmed) {
				const transcript = getConversationTranscript(ctx.sessionManager.getBranch());
				if (!transcript) {
					notify(ctx, "No conversation history to generate a name from.", "warning");
					return;
				}
				const name = await generateName(
					ctx,
					modelRef,
					"Name this session based on the full conversation history. Use 2-6 words in Title Case.",
					`Conversation history:\n${transcript}`,
				);
				if (!name) return;
				pi.setSessionName(name);
				notify(ctx, `Session renamed: ${name}`, "info");
				return;
			}

			if (trimmed === "show") {
				notify(ctx, `Rename model: ${formatRef(modelRef)}`, "info");
				return;
			}

			if (trimmed === "reset") {
				const def = defaultRef();
				persist(def);
				notify(ctx, `Rename model reset to ${formatRef(def)}`, "info");
				return;
			}

			if (trimmed === "help") {
				notify(ctx, USAGE, "info");
				return;
			}

			if (trimmed === "model" || trimmed.startsWith("model ")) {
				const modelArg = trimmed.slice(5).trim();

				// No model arg: open interactive picker
				if (!modelArg) {
					const picked = await openModelPicker(ctx, modelRef);
					if (!picked) return;
					const ok = persist(picked);
					notify(ctx, `Rename model set to ${formatRef(picked)}${ok ? "" : " (persist failed)"}`, ok ? "info" : "warning");
					return;
				}

				// Direct model arg: validate and set
				const ref = parseRef(modelArg);
				if (!ref) {
					notify(ctx, USAGE, "warning");
					return;
				}
				const resolved = await resolveAuth(ctx, ref);
				if (!resolved) return;
				const ok = persist(ref);
				notify(ctx, `Rename model set to ${formatRef(ref)}${ok ? "" : " (persist failed)"}`, ok ? "info" : "warning");
				return;
			}

			notify(ctx, USAGE, "warning");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		onSessionEvent(event, ctx);
		await autoName(ctx);
	});

	pi.on("session_tree", onSessionEvent);
	pi.on("session_switch", onSessionEvent);
	pi.on("session_fork", onSessionEvent);

	pi.on("message_end", async (_event, ctx) => { await autoName(ctx); });
	pi.on("agent_end", async (_event, ctx) => { await autoName(ctx); });
}
