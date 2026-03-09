import type { ChatMessage, Conversation } from "./types.js";

// ── Conversation Store ────────────────────────────────────────────────────────
// Key format: "${botId}:${channelId}" — isolates each bot's conversations.

export class ConversationStore {
  private readonly store = new Map<string, Conversation>();

  private key(botId: string, channelId: string): string {
    return `${botId}:${channelId}`;
  }

  get(botId: string, channelId: string): Conversation {
    const k = this.key(botId, channelId);
    if (!this.store.has(k)) {
      this.store.set(k, {
        history: [],
        turns: 0,
        handedOver: false,
        lastSeenMsgId: "",
      });
    }
    return this.store.get(k)!;
  }

  addUserMessage(
    botId: string,
    channelId: string,
    content: string,
    systemPrompt: string
  ): void {
    const conv = this.get(botId, channelId);
    if (conv.history.length === 0 && systemPrompt) {
      conv.history.push({ role: "system", content: systemPrompt });
    }
    conv.history.push({ role: "user", content });
  }

  addAssistantMessage(botId: string, channelId: string, content: string): void {
    const conv = this.get(botId, channelId);
    conv.history.push({ role: "assistant", content });
    conv.turns++;
  }

  reset(botId: string, channelId: string): void {
    this.store.delete(this.key(botId, channelId));
  }

  summary(botId: string, channelId: string): { turns: number; handedOver: boolean } {
    const conv = this.get(botId, channelId);
    return { turns: conv.turns, handedOver: conv.handedOver };
  }

  /** List all active conversations for a given bot. */
  listForBot(
    botId: string
  ): Array<{ channelId: string; turns: number; handedOver: boolean }> {
    const prefix = `${botId}:`;
    const results: Array<{ channelId: string; turns: number; handedOver: boolean }> = [];
    for (const [k, conv] of this.store) {
      if (k.startsWith(prefix)) {
        results.push({
          channelId: k.slice(prefix.length),
          turns: conv.turns,
          handedOver: conv.handedOver,
        });
      }
    }
    return results;
  }
}
