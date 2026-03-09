import WebSocket from "ws";
import type { CDPTab, Logger } from "./types.js";

// ── Utilities ─────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chrome's CDP /json listing reports WebSocket URLs as ws://localhost:PORT/…
 * even when running on a remote machine. Replace the host so our connection
 * goes to the actual node IP instead of localhost.
 */
export function rewriteWsHost(wsUrl: string, cdpHost: string): string {
  if (cdpHost === "127.0.0.1" || cdpHost === "localhost") return wsUrl;
  return wsUrl.replace(/^(ws:\/\/)(localhost|127\.0\.0\.1)/, `$1${cdpHost}`);
}

// ── CDP Session ───────────────────────────────────────────────────────────────

/**
 * Minimal Chrome DevTools Protocol client over a single WebSocket connection.
 * Each tab has its own CDPSession; do not share one session across tabs.
 */
export class CDPSession {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private nextId = 1;

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
      ws.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            id?: number;
            result?: unknown;
            error?: unknown;
          };
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        } catch {
          // Ignore CDP event frames that have no `id` (push events).
        }
      });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket not connected");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.ws as WebSocket).send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate a JavaScript expression in the page and return its value. */
  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return result?.result?.value;
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

// ── CDP node helpers ──────────────────────────────────────────────────────────

export async function fetchTabs(cdpHost: string, cdpPort: number): Promise<CDPTab[]> {
  const url = `http://${cdpHost}:${cdpPort}/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} from ${url}`);
  return (await res.json()) as CDPTab[];
}

export async function openNewTab(
  cdpHost: string,
  cdpPort: number,
  pageUrl: string
): Promise<CDPTab> {
  const url = `http://${cdpHost}:${cdpPort}/json/new?${encodeURIComponent(pageUrl)}`;
  const res = await fetch(url, { method: "PUT" });
  if (!res.ok) throw new Error(`CDP open-tab HTTP ${res.status}`);
  return (await res.json()) as CDPTab;
}

export async function closeTab(
  cdpHost: string,
  cdpPort: number,
  tabId: string
): Promise<void> {
  await fetch(`http://${cdpHost}:${cdpPort}/json/close/${tabId}`).catch(() => {});
}

// ── Discord message sender ────────────────────────────────────────────────────

/**
 * Build in-page script that inserts text via Discord's Slate editor instance.
 * Discord uses Slate.js; CDP Input.insertText often does not update Slate state.
 * This uses React internals to get the editor and call insertText(). Returns
 * true if text was inserted, false to fall back to CDP Input.insertText.
 */
function buildSlateInsertTextJS(text: string): string {
  const escaped = JSON.stringify(text);
  return `
(function (text) {
  try {
    var el = document.querySelector('[data-slate-editor="true"]') ||
             document.querySelector('[role="textbox"][contenteditable="true"]');
    if (!el) return false;
    var key = Object.keys(el).filter(function (k) { return k.indexOf('__react') === 0; })[0];
    if (!key) return false;
    var fiber = el[key];
    var editor = (fiber && fiber.child && fiber.child.memoizedProps && fiber.child.memoizedProps.node) ||
                 (fiber && fiber.memoizedProps && fiber.memoizedProps.node);
    if (!editor || typeof editor.insertText !== 'function') return false;
    el.focus();
    editor.insertText(text);
    return true;
  } catch (e) { return false; }
})(${escaped})`;
}

/**
 * Focus the Discord message input (Slate editor or contenteditable).
 * Prefers [data-slate-editor="true"] so Slate path can run afterward.
 */
const FOCUS_MESSAGE_INPUT_JS = `
(function () {
  var box = document.querySelector('[data-slate-editor="true"]') ||
            document.querySelector('[role="textbox"][contenteditable="true"]') ||
            document.querySelector('[role="textbox"][contenteditable]');
  if (!box) return false;
  box.click();
  box.focus();
  return true;
})()`;

/**
 * Type a message into the Discord DM input and send (Enter).
 * Prefers Slate editor.insertText() so the app registers the message; falls
 * back to CDP Input.insertText if Slate is unavailable.
 * Caller must ensure the correct DM channel is already open.
 */
export async function sendMessageRaw(
  sess: CDPSession,
  text: string,
  log: (msg: string) => void
): Promise<void> {
  const focused = (await sess.evaluate(FOCUS_MESSAGE_INPUT_JS)) as boolean;
  if (!focused) {
    log("Could not focus message input box");
    return;
  }

  await sleep(150);

  const usedSlate = (await sess.evaluate(buildSlateInsertTextJS(text))) as boolean;
  if (!usedSlate) {
    await sess.send("Input.insertText", { text });
  }

  await sleep(200);
  await sess.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sess.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(400);
}
