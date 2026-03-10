import crypto from "node:crypto";
import type { ChatMessage, Conversation } from "./types.js";

/** Max sent-message hashes to keep per channel for isFromSelf detection. */
const SENT_HASH_CAP = 100;

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Conversation Store ────────────────────────────────────────────────────────
// Keyed by channelId only — each worker manages a single bot account.

export class ConversationStore {
  private readonly store = new Map<string, Conversation>();
  private readonly sentHashes = new Map<string, Set<string>>();

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

  /** Record a message we sent in this channel; used to mark isFromSelf by content hash. */
  addSentHash(channelId: string, content: string): void {
    let set = this.sentHashes.get(channelId);
    if (!set) {
      set = new Set();
      this.sentHashes.set(channelId, set);
    }
    set.add(contentHash(content));
    if (set.size > SENT_HASH_CAP) {
      const arr = Array.from(set);
      arr.splice(0, arr.length - SENT_HASH_CAP);
      this.sentHashes.set(channelId, new Set(arr));
    }
  }

  /** True if this content matches a message we sent in this channel. */
  hasSentHash(channelId: string, content: string): boolean {
    return this.sentHashes.get(channelId)?.has(contentHash(content)) ?? false;
  }

  reset(channelId: string): void {
    this.store.delete(channelId);
    this.sentHashes.delete(channelId);
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
