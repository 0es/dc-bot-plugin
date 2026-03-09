import type { ChatMessage, WorkerConfig } from "./types.js";

// ── Request helpers ─────────────────────────────────────────────────────────────

/** Ensure content is a string safe for JSON and LLM APIs (no null bytes, no C0/C1 control chars). */
function sanitizeContent(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  return s
    .replace(/\0/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .trim();
}

/**
 * Build request body for llama-server (OpenAI-compatible).
 * Uses chat_template_kwargs.enable_thinking: false so the model returns direct reply in content.
 */
function buildRequestBody(
  messages: ChatMessage[],
  cfg: WorkerConfig
): string {
  const safe = messages.map((m) => ({
    role: m.role,
    content: sanitizeContent(m.content),
  }));
  const payload = {
    model: cfg.llmModel || "default",
    messages: safe,
    stream: false,
    max_tokens: 512,
    chat_template_kwargs: { enable_thinking: false },
  };
  return JSON.stringify(payload);
}

// ── LLM Client ────────────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible chat completions endpoint.
 * Returns the assistant's reply text, or an empty string if the response
 * contains no choices.
 */
export async function callLLM(messages: ChatMessage[], cfg: WorkerConfig): Promise<string> {
  if (!messages.length) {
    return "";
  }

  let body: string;
  try {
    body = buildRequestBody(messages, cfg);
  } catch (e) {
    throw new Error(`LLM request build failed: ${(e as Error).message}`);
  }

  const url = `${cfg.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${cfg.llmApiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${bodyText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const raw = extractReply(data);
  const out = raw.trim();
  if (!out) {
    logEmptyResponse(data);
  }
  return out;
}

// ── Response extraction (llama-server / OpenAI-compatible) ──────────────────────

/**
 * Extract assistant reply from llama-server (and compatible) response.
 * Order: message.content (string or part[].text) → message.reasoning_content → choice.text/content.
 */
function extractReply(data: Record<string, unknown>): string {
  const first = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (!first) return "";

  const msg = first.message as Record<string, unknown> | undefined;
  if (msg) {
    const content = stringFromContent(msg.content);
    if (content) return content;
    const reasoning = msg.reasoning_content;
    if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
  }

  if (typeof first.text === "string") return first.text;
  if (typeof first.content === "string") return first.content;
  return "";
}

/** Coerce message.content (string | array of parts | object) to a single string. */
function stringFromContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPart = content.find(
      (p) => p && typeof p === "object" && (p as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    const t = textPart?.text;
    return typeof t === "string" ? t : "";
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.value === "string") return o.value;
  }
  return "";
}

function logEmptyResponse(data: Record<string, unknown>): void {
  const keys = Object.keys(data).join(", ");
  const first = (data.choices as unknown[])?.[0];
  const firstKeys = first && typeof first === "object" ? Object.keys(first as object).join(", ") : "none";
  const msg =
    first && typeof first === "object"
      ? (first as Record<string, unknown>).message != null
        ? "message keys: " + Object.keys((first as Record<string, unknown>).message as object).join(", ")
        : "no message"
      : "";
  console.warn(
    "[llm] Response had no extractable content. Top-level keys: %s; choices[0] keys: %s; %s",
    keys,
    firstKeys,
    msg
  );
}
