import type { ChatMessage, WorkerConfig } from "./types.js";

// ── LLM Client ────────────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible chat completions endpoint.
 * Returns the assistant's reply text, or an empty string if the response
 * contains no choices.
 */
export async function callLLM(messages: ChatMessage[], cfg: WorkerConfig): Promise<string> {
  const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.llmApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages,
      stream: false,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
