import type { ClaudeResponse, ClaudeMessage } from "./types.ts";
import { sendToClaudeCode, type ClaudeModelOptions } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";

// Callback that creates (or retrieves) a session thread and returns a
// sender function bound to that thread.
export interface SessionThreadCallbacks {
  /**
   * Create a new Discord thread for this session and return a sender bound to it.
   * Also posts a summary embed in the main channel linking to the thread.
   *
   * @param prompt The user's prompt (used to name the thread)
   * @param sessionId Optional pre-existing session ID (reuses thread if one exists)
   * @returns Object with the thread-bound sender and a placeholder session key
   */
  createThreadSender(prompt: string, sessionId?: string, threadName?: string): Promise<{
    sender: (messages: ClaudeMessage[]) => Promise<void>;
    threadSessionKey: string;
    threadChannelId: string;
  }>;
  /**
   * Look up an existing thread for a session (does NOT create one).
   * Returns undefined if the session has no thread.
   */
  getThreadSender(sessionId: string): Promise<{
    sender: (messages: ClaudeMessage[]) => Promise<void>;
    threadSessionKey: string;
  } | undefined>;
  /**
   * Update the session key mapping when the real SDK session ID arrives.
   */
  updateSessionId(oldKey: string, newSessionId: string): void;
}

// Discord command definitions
export const claudeCommands = [
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Send message to Claude Code (auto-continues in current channel)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID to resume (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-thread')
    .setDescription('Start a new Claude session in a dedicated thread')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Thread name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the most recent Claude Code session (across all channels)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-cancel')
    .setDescription('Cancel currently running Claude Code command'),
];

export interface ClaudeHandlerDeps {
  workDir: string;
  /** Per-channel working-directory resolver. Returns the channel's bound
   *  project directory, or undefined to fall back to the global workDir. */
  getWorkDirForChannel?: (channelId: string) => string | undefined;
  /** Legacy global getter — retained for back-compat. */
  getClaudeController: () => AbortController | null;
  /** Legacy global setter — retained for back-compat. */
  setClaudeController: (controller: AbortController | null) => void;
  /** Per-channel AbortController getter. When provided, /claude in one
   *  channel no longer aborts concurrent /claude calls in other channels. */
  getChannelController?: (channelId: string) => AbortController | null;
  /** Per-channel AbortController setter (null to clear). */
  setChannelController?: (channelId: string, controller: AbortController | null) => void;
  /** Get session ID for a specific channel/thread (per-channel tracking) */
  getSessionForChannel: (channelId: string) => string | undefined;
  /** Set session ID for a specific channel/thread */
  setSessionForChannel: (channelId: string, sessionId: string | undefined) => void;
  /** Legacy global getter (for /resume — find most recent across channels) */
  getClaudeSessionId: () => string | undefined;
  /** Legacy global setter (keeps backward compat for session manager) */
  setClaudeSessionId: (sessionId: string | undefined) => void;
  /** Default sender — used when no thread is available (fallback) */
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  /** Get current runtime options from unified settings (thinking, operation, proxy) */
  getQueryOptions?: () => ClaudeModelOptions;
  /** Thread-per-session callbacks (optional — when absent, falls back to main channel) */
  sessionThreads?: SessionThreadCallbacks;
}

export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  const { workDir, sendClaudeMessages } = deps;

  /** Resolve the working directory for a given channel, falling back to global workDir. */
  const resolveWorkDir = (channelId: string): string => {
    return deps.getWorkDirForChannel?.(channelId) ?? workDir;
  };

  /**
   * Acquire an AbortController scoped to a channel. If the channel already
   * has an active controller, it is aborted first. When per-channel ops are
   * not wired, falls back to the legacy global slot (original behavior).
   */
  const acquireController = (channelId: string): AbortController => {
    if (deps.getChannelController && deps.setChannelController) {
      const existing = deps.getChannelController(channelId);
      if (existing) existing.abort();
      const controller = new AbortController();
      deps.setChannelController(channelId, controller);
      return controller;
    }
    // Legacy path: global controller, aborts any prior /claude in any channel.
    const existing = deps.getClaudeController();
    if (existing) existing.abort();
    const controller = new AbortController();
    deps.setClaudeController(controller);
    return controller;
  };

  /** Release the channel's controller slot. */
  const releaseController = (channelId: string): void => {
    if (deps.setChannelController) {
      deps.setChannelController(channelId, null);
      return;
    }
    deps.setClaudeController(null);
  };

  return {
    /**
     * /claude — Send a message to Claude. Auto-continues the session active in the
     * current channel/thread. Starts a new session only if there isn't one yet.
     */
    // deno-lint-ignore no-explicit-any
    async onClaude(ctx: any, prompt: string, channelId: string, explicitSessionId?: string): Promise<ClaudeResponse> {
      const controller = acquireController(channelId);

      await ctx.deferReply();

      // Resolve which session to resume:
      // 1) Explicit session_id from user → resume that
      // 2) Active session in this channel/thread → resume that
      // 3) None → start a new session
      const activeSessionId = explicitSessionId || deps.getSessionForChannel(channelId);

      // Pick the right sender — if this channel has a thread, use it
      let activeSender = sendClaudeMessages;
      if (activeSessionId && deps.sessionThreads) {
        try {
          const existing = await deps.sessionThreads.getThreadSender(activeSessionId);
          if (existing) {
            activeSender = existing.sender;
          }
        } catch { /* fallback to main sender */ }
      }

      const isResuming = !!activeSessionId;

      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: isResuming ? 'Claude Code Continuing...' : 'Claude Code Running...',
          description: isResuming ? 'Continuing session...' : 'Starting new session...',
          fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true
        }]
      });

      const result = await sendToClaudeCode(
        resolveWorkDir(channelId),
        prompt,
        controller,
        activeSessionId, // resume if present, new session if undefined
        undefined,
        (jsonData) => {
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        false,
        deps.getQueryOptions?.()
      );

      // Track session per-channel and globally
      if (result.sessionId) {
        deps.setSessionForChannel(channelId, result.sessionId);
      }
      deps.setClaudeSessionId(result.sessionId);
      releaseController(channelId);

      return result;
    },

    /**
     * /claude-thread — Start a brand-new session in a dedicated Discord thread.
     * The new thread inherits the invoking channel's project binding (if any).
     */
    // deno-lint-ignore no-explicit-any
    async onClaudeThread(ctx: any, prompt: string, threadName?: string): Promise<ClaudeResponse> {
      // Resolve the invoking channel so the spawned thread inherits its project binding.
      const invokingChannelId: string = typeof ctx?.getChannelId === 'function'
        ? ctx.getChannelId()
        : '';
      // The thread's own channelId isn't known yet; key the controller to the
      // invoking channel temporarily, transfer to the thread channel after creation.
      const controller = acquireController(invokingChannelId);

      await ctx.deferReply();

      // Create a dedicated thread for this session
      let activeSender = sendClaudeMessages;
      let threadSessionKey: string | undefined;
      let threadChannelId: string | undefined;

      if (deps.sessionThreads) {
        try {
          const threadResult = await deps.sessionThreads.createThreadSender(prompt, undefined, threadName);
          activeSender = threadResult.sender;
          threadSessionKey = threadResult.threadSessionKey;
          threadChannelId = threadResult.threadChannelId;
        } catch (err) {
          console.warn('[SessionThread] Could not create thread, falling back to main channel:', err);
        }
      }

      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: 'Claude Code Running...',
          description: threadSessionKey
            ? 'Session started in a dedicated thread — check below ↓'
            : 'Starting new session...',
          fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true
        }]
      });

      const result = await sendToClaudeCode(
        resolveWorkDir(invokingChannelId),
        prompt,
        controller,
        undefined, // always a new session
        undefined,
        (jsonData) => {
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        false,
        deps.getQueryOptions?.()
      );

      deps.setClaudeSessionId(result.sessionId);
      releaseController(invokingChannelId);

      // Map the thread channel → session so /claude inside the thread auto-continues
      if (threadSessionKey && result.sessionId && deps.sessionThreads) {
        deps.sessionThreads.updateSessionId(threadSessionKey, result.sessionId);
      }
      if (threadChannelId && result.sessionId) {
        deps.setSessionForChannel(threadChannelId, result.sessionId);
      }

      return result;
    },

    /**
     * /resume — Continue the most recent session (global, not per-channel).
     * If that session has a thread, output goes there.
     */
    // deno-lint-ignore no-explicit-any
    async onContinue(ctx: any, prompt?: string): Promise<ClaudeResponse> {
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const actualPrompt = prompt || "Please continue.";

      await ctx.deferReply();

      // Check if the most recent session has a thread — if so, reuse it
      let activeSender = sendClaudeMessages;
      let isReusingThread = false;

      if (deps.sessionThreads) {
        const currentSessionId = deps.getClaudeSessionId();
        if (currentSessionId) {
          try {
            const existing = await deps.sessionThreads.getThreadSender(currentSessionId);
            if (existing) {
              activeSender = existing.sender;
              isReusingThread = true;
            }
          } catch (err) {
            console.warn('[SessionThread] Could not reuse thread for continue, falling back:', err);
          }
        }
      }

      const embedData: { color: number; title: string; description: string; timestamp: boolean; fields?: Array<{ name: string; value: string; inline: boolean }> } = {
        color: 0xffff00,
        title: 'Claude Code Continuing Conversation...',
        description: isReusingThread
          ? 'Continuing in session thread...'
          : 'Loading latest conversation and waiting for response...',
        timestamp: true
      };

      if (prompt) {
        embedData.fields = [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }];
      }

      await ctx.editReply({ embeds: [embedData] });

      const result = await sendToClaudeCode(
        workDir,
        actualPrompt,
        controller,
        undefined,
        undefined,
        (jsonData) => {
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        true, // continueMode = true
        deps.getQueryOptions?.()
      );

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

      return result;
    },

    // deno-lint-ignore no-explicit-any
    onClaudeCancel(ctx: any): boolean {
      // Try to cancel the invoking channel's /claude first — more intuitive
      // than cancelling whatever happens to be the "most recent" globally.
      const channelId: string = typeof ctx?.getChannelId === 'function'
        ? ctx.getChannelId()
        : '';
      const channelController = channelId && deps.getChannelController
        ? deps.getChannelController(channelId)
        : null;

      if (channelController) {
        console.log(`Cancelling Claude Code session for channel ${channelId}`);
        channelController.abort();
        deps.setChannelController?.(channelId, null);
        return true;
      }

      // Fall back to the legacy global slot.
      const currentController = deps.getClaudeController();
      if (!currentController) {
        return false;
      }
      console.log("Cancelling Claude Code session (global fallback)...");
      currentController.abort();
      deps.setClaudeController(null);
      deps.setClaudeSessionId(undefined);
      return true;
    },

    // ────────── External hooks (for non-slash-command callers) ──────────

    /** Get the session ID bound to a Discord channel/thread. */
    getSessionForChannel(channelId: string): string | undefined {
      return deps.getSessionForChannel(channelId);
    },
    /** Update the session ID for a Discord channel/thread (persists).
     *  Used by forum-thread auto-sessions and other externally-spawned flows. */
    setSessionForChannel(channelId: string, sessionId: string | undefined): void {
      deps.setSessionForChannel(channelId, sessionId);
    },
  };
}
