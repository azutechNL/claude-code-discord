/**
 * Honcho REST API client for the Discord bot.
 *
 * Wraps the Honcho v3 API with the subset of operations the bot needs:
 * workspace/peer/session lifecycle, message storage, and context retrieval.
 * All methods are fire-and-forget safe (catch + log on failure) for the
 * post-query storage path, and throw for the pre-query context path so
 * the caller can decide whether to proceed without context.
 *
 * Follows the same pattern as openclaw-mcp.ts: config-from-env factory,
 * undefined-when-disabled guard, stateless HTTP client.
 *
 * @module claude/honcho-client
 */

export interface HonchoClientConfig {
  /** Base URL of the Honcho API (e.g. http://honcho-api:8000) */
  baseUrl: string;
  /** Default workspace ID */
  workspaceId: string;
}

export interface HonchoContext {
  messages: Array<{ content: string; peer_id: string; created_at: string }>;
  summary: string | null;
  peer_representation: string | null;
  peer_card: string | null;
}

/**
 * Read config from environment. Returns undefined when not configured.
 */
export function getHonchoConfig(): HonchoClientConfig | undefined {
  const baseUrl = Deno.env.get("HONCHO_API_URL");
  if (!baseUrl) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    workspaceId: Deno.env.get("HONCHO_WORKSPACE_ID") ?? "discord-bot",
  };
}

/**
 * Stateless HTTP client for Honcho v3 API.
 */
export class HonchoClient {
  constructor(private readonly config: HonchoClientConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl}/v3/workspaces/${this.config.workspaceId}${path}`;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Honcho POST ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(this.url(path));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Honcho GET ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // ────────── Workspace ──────────

  /** Ensure the workspace exists (idempotent). */
  async ensureWorkspace(): Promise<void> {
    try {
      await fetch(`${this.config.baseUrl}/v3/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: this.config.workspaceId }),
      });
    } catch { /* ignore — may already exist */ }
  }

  // ────────── Peers ──────────

  /** Get or create a peer (idempotent). */
  async getOrCreatePeer(peerId: string, name?: string): Promise<void> {
    try {
      await this.post("/peers", { id: peerId, name: name ?? peerId });
    } catch (err) {
      // 409/422 = already exists, which is fine
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("409") && !msg.includes("422") && !msg.includes("already")) {
        throw err;
      }
    }
  }

  // ────────── Sessions ──────────

  /**
   * Get or create a session with peer observation settings (idempotent).
   * @param peers Map of peerId → { observe_me, observe_others }
   */
  async getOrCreateSession(
    sessionId: string,
    peers?: Record<string, { observe_me?: boolean; observe_others?: boolean }>,
  ): Promise<void> {
    try {
      await this.post("/sessions", {
        id: sessionId,
        ...(peers ? { peers } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("409") && !msg.includes("422") && !msg.includes("already")) {
        throw err;
      }
    }
  }

  // ────────── Messages ──────────

  /** Store messages in a session. Fire-and-forget safe. */
  async addMessages(
    sessionId: string,
    messages: Array<{ content: string; peer_id: string }>,
  ): Promise<void> {
    await this.post(`/sessions/${sessionId}/messages`, { messages });
  }

  // ────────── Context ──────────

  /** Get session context (messages + summary + peer representation). */
  async getContext(sessionId: string): Promise<HonchoContext> {
    return (await this.get(`/sessions/${sessionId}/context`)) as HonchoContext;
  }

  /** Get a peer's cross-session context / representation. */
  async getPeerContext(peerId: string): Promise<unknown> {
    return await this.get(`/peers/${peerId}/context`);
  }

  /** Search a peer's conclusions semantically. */
  async searchPeer(peerId: string, query: string): Promise<unknown> {
    return await this.post(`/peers/${peerId}/search`, { query });
  }

  /** Chat with a peer's representation via the dialectic agent. */
  async chatPeer(peerId: string, query: string): Promise<string> {
    const res = (await this.post(`/peers/${peerId}/chat`, { query })) as {
      content?: string;
      response?: string;
    };
    return res.content ?? res.response ?? JSON.stringify(res);
  }
}

/**
 * Factory: build a HonchoClient from environment, or undefined if not configured.
 */
export function buildHonchoClient(): HonchoClient | undefined {
  const config = getHonchoConfig();
  if (!config) return undefined;
  return new HonchoClient(config);
}
