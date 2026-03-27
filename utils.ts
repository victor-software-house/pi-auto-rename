import type { Message, TextContent } from "@mariozechner/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

const NAME_LENGTH_CAP = 80;

// ─── Content extraction ───────────────────────────────────────────────────────

function isLlmMessage(entry: SessionEntry): entry is SessionMessageEntry & { message: Message } {
	if (entry.type !== "message") return false;
	const role = (entry as SessionMessageEntry).message.role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

function extractText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push((block as TextContent).text);
	}
	return parts.join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Find the earliest user message text in a session branch.
 * Branch entries arrive newest-first, so scan from the end.
 */
export function getFirstUserMessageText(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || !isLlmMessage(entry)) continue;
		if (entry.message.role !== "user") continue;
		const text = extractText(entry.message.content).trim();
		if (text) return text;
	}
	return null;
}

/**
 * Build a chronological transcript of user/assistant messages.
 */
export function getConversationTranscript(entries: SessionEntry[]): string {
	const segments: string[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || !isLlmMessage(entry)) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(content).trim();
		if (!text) continue;
		segments.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return segments.join("\n\n");
}

/**
 * Clean up a raw model response into a usable session name.
 */
export function sanitizeSessionName(raw: string): string {
	const firstLine = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!firstLine) return "";

	let name = firstLine
		.replace(/^["'`]+/, "")
		.replace(/["'`]+$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?:;,]+$/, "");

	if (name.length > NAME_LENGTH_CAP) name = name.slice(0, NAME_LENGTH_CAP).trimEnd();
	return name;
}
