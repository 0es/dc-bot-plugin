import type { ChatMessage, WorkerConfig } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Ensure content is a string safe for JSON and LLM APIs (no null bytes, no other C0/C1 control chars). */
function sanitizeContent(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  return s
    .replace(/\0/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .trim();
}

/** Build a clean messages array and body so the server never sees invalid or surprising input. */
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

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}
