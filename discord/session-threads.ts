/**
 * Session Thread Manager — Maps Claude sessions to dedicated Discord threads.
 *
 * Each `/claude` invocation creates a new thread in the bot's main channel.
 * All output, AskUser prompts, and permission requests for that session
 * are routed into the thread, keeping the main channel clean.
 *
 * @module discord/session-threads
 */

import {
  ChannelType,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from "npm:discord.js@14.14.1";

import type { SessionThread } from "./types.ts";
import type {
  PersistedThreadSession,
  PersistenceManager,
} from "../util/persistence.ts";

/**
 * Interface for the subset of PersistenceManager we use, to avoid a tight
 * coupling (and to keep unit testing trivial).
 */
export interface ThreadPersister {
  save(data: PersistedThreadSession[]): Promise<boolean>;
  load(defaultValue: PersistedThreadSession[]): Promise<PersistedThreadSession[]>;
}

/**
 * Truncate and sanitise a user prompt into a thread name (max 100 chars for Discord).
 */
export function threadNameFromPrompt(prompt: string): string {
  // Strip code fences and excessive whitespace
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\n+/g, " ")
    .trim();

  const maxLen = 80; // Leave room for potential prefix
  if (cleaned.length <= maxLen) return cleaned || "Claude Session";
  return cleaned.substring(0, maxLen - 1) + "…";
}

/**
 * Manages the mapping between Claude sessions and Discord threads.
 */
export class SessionThreadManager {
  /** sessionId → SessionThread metadata */
  private threads = new Map<string, SessionThread>();
  /** sessionId → live ThreadChannel reference (may be stale) */
  private threadChannels = new Map<string, ThreadChannel>();
  /** sessionId → parent channel ID (for restoring ThreadChannel refs after restart) */
  private parentChannels = new Map<string, string>();
  /** Optional persister for surviving restarts. */
  private persister?: ThreadPersister;

  constructor(persister?: ThreadPersister) {
    this.persister = persister;
  }

  // ───────────────────── Create ─────────────────────

  /**
   * Create a new Discord thread for a session and register it.
   *
   * @param channel  The bot's main text channel
   * @param sessionId  Claude session ID (may be placeholder before SDK returns one)
   * @param prompt  The user's prompt — used to name the thread
   * @returns The created ThreadChannel
   */
  async createSessionThread(
    channel: TextChannel,
    sessionId: string,
    prompt: string,
    threadName?: string,
  ): Promise<ThreadChannel> {
    const name = threadName || threadNameFromPrompt(prompt);

    const thread = await channel.threads.create({
      name,
      type: ChannelType.PublicThread,
      autoArchiveDuration: 1440, // 24 hours
      reason: `Claude session ${sessionId}`,
    });

    const meta: SessionThread = {
      sessionId,
      threadId: thread.id,
      threadName: name,
      createdAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
    };

    this.threads.set(sessionId, meta);
    this.threadChannels.set(sessionId, thread);
    this.parentChannels.set(sessionId, channel.id);

    this.schedulePersist();
    return thread;
  }

  /**
   * Register an existing ThreadChannel (e.g. a new forum post) as a
   * Claude session. Unlike {@link createSessionThread}, the Discord
   * thread already exists — we just track it.
   *
   * @param thread        The existing Discord thread.
   * @param sessionId     Placeholder or real session ID.
   * @param displayName   Optional custom name for bookkeeping.
   */
  registerExistingThread(
    thread: ThreadChannel,
    sessionId: string,
    displayName?: string,
  ): void {
    const meta: SessionThread = {
      sessionId,
      threadId: thread.id,
      threadName: displayName ?? thread.name,
      createdAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
    };
    this.threads.set(sessionId, meta);
    this.threadChannels.set(sessionId, thread);
    if (thread.parentId) {
      this.parentChannels.set(sessionId, thread.parentId);
    }
    this.schedulePersist();
  }

  // ───────────────────── Lookup ─────────────────────

  /**
   * Get the ThreadChannel for a session, if it exists.
   */
  getThread(sessionId: string): ThreadChannel | undefined {
    return this.threadChannels.get(sessionId);
  }

  /**
   * Get the metadata for a session thread.
   */
  getSessionThread(sessionId: string): SessionThread | undefined {
    return this.threads.get(sessionId);
  }

  /**
   * Find a session ID by its Discord thread ID.
   */
  findSessionByThreadId(threadId: string): string | undefined {
    for (const [sessionId, meta] of this.threads) {
      if (meta.threadId === threadId) return sessionId;
    }
    return undefined;
  }

  /**
   * List all tracked session threads.
   */
  getAllSessionThreads(): SessionThread[] {
    return Array.from(this.threads.values());
  }

  /**
   * List active session threads (those with recent activity).
   */
  getActiveSessionThreads(maxAgeMs = 3_600_000): SessionThread[] {
    const cutoff = Date.now() - maxAgeMs;
    return Array.from(this.threads.values()).filter(
      (t) => t.lastActivity.getTime() > cutoff,
    );
  }

  // ───────────────────── Update ─────────────────────

  /**
   * Record that a message was sent in a session thread.
   */
  recordActivity(sessionId: string): void {
    const meta = this.threads.get(sessionId);
    if (meta) {
      meta.lastActivity = new Date();
      meta.messageCount++;
    }
  }

  /**
   * Update the session ID mapping (e.g., when the real SDK session ID arrives
   * after we created the thread with a placeholder).
   */
  updateSessionId(oldId: string, newId: string): void {
    const meta = this.threads.get(oldId);
    const channel = this.threadChannels.get(oldId);
    const parentId = this.parentChannels.get(oldId);

    if (meta) {
      meta.sessionId = newId;
      this.threads.delete(oldId);
      this.threads.set(newId, meta);
    }

    if (channel) {
      this.threadChannels.delete(oldId);
      this.threadChannels.set(newId, channel);
    }

    if (parentId) {
      this.parentChannels.delete(oldId);
      this.parentChannels.set(newId, parentId);
    }

    this.schedulePersist();
  }

  /**
   * Store a ThreadChannel reference obtained externally (e.g., fetched from cache).
   */
  setThreadChannel(sessionId: string, thread: ThreadChannel): void {
    this.threadChannels.set(sessionId, thread);
    if (thread.parentId) {
      this.parentChannels.set(sessionId, thread.parentId);
    }
  }

  // ───────────────────── Cleanup ─────────────────────

  /**
   * Remove sessions older than the given age.
   * Does NOT archive the Discord threads — that's handled by autoArchiveDuration.
   */
  cleanup(maxAgeMs = 24 * 3_600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, meta] of this.threads) {
      if (meta.lastActivity.getTime() < cutoff) {
        this.threads.delete(id);
        this.threadChannels.delete(id);
        this.parentChannels.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.schedulePersist();
    return removed;
  }

  // ───────────────────── Persistence ─────────────────────

  /**
   * Serialize the in-memory state into a JSON-safe snapshot.
   */
  snapshot(): PersistedThreadSession[] {
    const out: PersistedThreadSession[] = [];
    for (const [sessionId, meta] of this.threads) {
      out.push({
        sessionId,
        threadId: meta.threadId,
        threadName: meta.threadName,
        createdAt: meta.createdAt.toISOString(),
        lastActivity: meta.lastActivity.toISOString(),
        messageCount: meta.messageCount,
        parentChannelId: this.parentChannels.get(sessionId),
      });
    }
    return out;
  }

  /**
   * Pending-save state to coalesce bursts of writes.
   * @internal
   */
  private pendingSave = false;

  /**
   * Save to the persister on the next microtask, coalescing rapid-fire
   * mutations into a single write. Fire-and-forget; logs but never throws.
   */
  private schedulePersist(): void {
    if (!this.persister || this.pendingSave) return;
    this.pendingSave = true;
    queueMicrotask(() => {
      this.pendingSave = false;
      this.persister
        ?.save(this.snapshot())
        .catch((err) => console.error("[SessionThreadManager] persist failed:", err));
    });
  }

  /**
   * Load persisted thread metadata from disk and restore the in-memory maps.
   * ThreadChannel references are NOT yet populated — call {@link restoreChannels}
   * after the Discord client is ready.
   *
   * @returns Number of sessions restored
   */
  async loadPersisted(): Promise<number> {
    if (!this.persister) return 0;
    const persisted = await this.persister.load([]);
    for (const p of persisted) {
      this.threads.set(p.sessionId, {
        sessionId: p.sessionId,
        threadId: p.threadId,
        threadName: p.threadName,
        createdAt: new Date(p.createdAt),
        lastActivity: new Date(p.lastActivity),
        messageCount: p.messageCount,
      });
      if (p.parentChannelId) {
        this.parentChannels.set(p.sessionId, p.parentChannelId);
      }
    }
    console.log(`[SessionThreadManager] Loaded ${persisted.length} persisted session thread(s)`);
    return persisted.length;
  }

  /**
   * Fetch ThreadChannel references from the Discord client for every
   * loaded session. Call after `client.once('ready', ...)` has fired.
   * Drops any sessions whose Discord thread no longer exists.
   *
   * @returns Number of channels successfully restored
   */
  async restoreChannels(client: Client): Promise<number> {
    let restored = 0;
    const dropped: string[] = [];

    for (const [sessionId, meta] of this.threads) {
      try {
        const ch = await client.channels.fetch(meta.threadId);
        if (ch && ch.isThread()) {
          this.threadChannels.set(sessionId, ch as ThreadChannel);
          if (ch.parentId) {
            this.parentChannels.set(sessionId, ch.parentId);
          }
          restored++;
        } else {
          dropped.push(sessionId);
        }
      } catch {
        // Thread was deleted on Discord side — drop it
        dropped.push(sessionId);
      }
    }

    for (const id of dropped) {
      this.threads.delete(id);
      this.threadChannels.delete(id);
      this.parentChannels.delete(id);
    }

    console.log(
      `[SessionThreadManager] Restored ${restored} thread channel(s)` +
        (dropped.length > 0 ? `, dropped ${dropped.length} missing thread(s)` : ""),
    );

    if (dropped.length > 0) this.schedulePersist();
    return restored;
  }
}
