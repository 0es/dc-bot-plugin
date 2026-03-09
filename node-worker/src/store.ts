import type { ChatMessage, Conversation } from "./types.js";

// ── Conversation Store ────────────────────────────────────────────────────────
// Keyed by channelId only — each worker manages a single bot account.

export class ConversationStore {
  private readonly store = new Map<string, Conversation>();

  get(channelId: string): Conversation {
    if (!this.store.has(channelId)) {
      this.store.set(channelId, {
        history: [],
        turns: 0,
        handedOver: false,
        lastSeenMsgId: "",
      });
    }
    return this.store.get(channelId)!;
  }

  addUserMessage(channelId: string, content: string, systemPrompt: string): void {
    const conv = this.get(channelId);
    if (conv.history.length === 0 && systemPrompt) {
      conv.history.push({ role: "system", content: systemPrompt });
    }
    conv.history.push({ role: "user", content });
  }

  addAssistantMessage(channelId: string, content: string): void {
    const conv = this.get(channelId);
    conv.history.push({ role: "assistant", content });
    conv.turns++;
  }

  reset(channelId: string): void {
    this.store.delete(channelId);
  }

  summary(channelId: string): { turns: number; handedOver: boolean } {
    const conv = this.get(channelId);
    return { turns: conv.turns, handedOver: conv.handedOver };
  }

  listAll(): Array<{ channelId: string; turns: number; handedOver: boolean }> {
    const results: Array<{ channelId: string; turns: number; handedOver: boolean }> = [];
    for (const [channelId, conv] of this.store) {
      results.push({ channelId, turns: conv.turns, handedOver: conv.handedOver });
    }
    return results;
  }
}
