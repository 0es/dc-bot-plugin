import type { DmStatus, RecruitResult, WorkerStatus } from "./types.js";

// ── Worker HTTP Client ────────────────────────────────────────────────────────

/**
 * Thin HTTP client that wraps the node-worker REST API.
 * One instance is created per configured bot.
 */
export class WorkerClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * GET /status
   * Returns the worker's running state, self-username, and active conversations.
   */
  async getStatus(): Promise<WorkerStatus> {
    const res = await fetch(`${this.baseUrl}/status`);
    if (!res.ok) throw new Error(`Worker /status HTTP ${res.status}`);
    return res.json() as Promise<WorkerStatus>;
  }

  /**
   * GET /dms/:channelId
   * Returns the AI turn state for a specific DM channel.
   */
  async getDmStatus(channelId: string): Promise<DmStatus> {
    const res = await fetch(`${this.baseUrl}/dms/${channelId}`);
    if (!res.ok) throw new Error(`Worker GET /dms/${channelId} HTTP ${res.status}`);
    return res.json() as Promise<DmStatus>;
  }

  /**
   * DELETE /dms/:channelId
   * Resets the AI turn counter so the bot resumes auto-replying.
   */
  async resetDm(channelId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/dms/${channelId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Worker DELETE /dms/${channelId} HTTP ${res.status}`);
  }

  /**
   * POST /recruit
   * Instructs the worker to run an outbound recruitment session.
   */
  async recruit(
    guildId: string,
    channelId: string,
    count: number,
    message?: string
  ): Promise<RecruitResult> {
    const res = await fetch(`${this.baseUrl}/recruit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, channelId, count, message }),
    });
    if (!res.ok) throw new Error(`Worker /recruit HTTP ${res.status}`);
    return res.json() as Promise<RecruitResult>;
  }
}
