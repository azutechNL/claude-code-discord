#!/usr/bin/env -S deno run --allow-all

/**
 * Claude Code Discord Bot - Main Entry Point
 *
 * This file bootstraps the Discord bot with Claude Code integration.
 * Most command handlers are now extracted to core modules for maintainability.
 *
 * @module index
 */

import {
  createDiscordBot,
  type BotConfig,
  type InteractionContext,
  type CommandHandlers,
  type ButtonHandlers,
  type BotDependencies,
  type MessageContent,
  SessionThreadManager,
} from "./discord/index.ts";
import { Events, ChannelType, type TextChannel } from "npm:discord.js@14.14.1";
import {
  initAllPersistence,
  getChannelSessionsManager,
  getThreadSessionsManager,
  getChannelBindingsManager,
} from "./util/persistence.ts";
import {
  ChannelBindingManager,
  createBindCommandHandlers,
  PersonaManager,
  createPersonaCommandHandlers,
  mergePersonaIntoOptions,
  createSessionCommandHandlers,
  createHonchoCommandHandlers,
  runSetupWizard,
} from "./core/index.ts";
import type { ClaudeModelOptions } from "./claude/index.ts";

import { getGitInfo } from "./git/index.ts";
import { createClaudeSender, createQuietClaudeSender, expandableContent, sendToClaudeCode, convertToClaudeMessages, type DiscordSender, type ClaudeMessage, type SessionThreadCallbacks, buildDashboardHooks, getDashboardEndpoints, mergeHooks, buildOpenclawMcpServer, buildHonchoClient, buildHonchoMcpServer, type HonchoMcpContext, buildJiraClient, buildJiraMcpServer, buildTeamClient, buildTeamMcpServer } from "./claude/index.ts";
import { buildQuestionMessages, parseAskUserButtonId, parseAskUserConfirmId, type AskUserQuestionInput } from "./claude/index.ts";
import { buildPermissionEmbed, parsePermissionButtonId, type PermissionRequestCallback } from "./claude/index.ts";
import { claudeCommands, enhancedClaudeCommands } from "./claude/index.ts";
import { additionalClaudeCommands } from "./claude/additional-index.ts";
import { initModels } from "./claude/enhanced-client.ts";
import { advancedSettingsCommands, DEFAULT_SETTINGS, unifiedSettingsCommands, UNIFIED_DEFAULT_SETTINGS } from "./settings/index.ts";
import { gitCommands } from "./git/index.ts";
import { shellCommands } from "./shell/index.ts";
import { utilsCommands } from "./util/index.ts";
import { systemCommands } from "./system/index.ts";
import { helpCommand } from "./help/index.ts";
import { agentCommand } from "./agent/index.ts";
import { cleanupPaginationStates } from "./discord/index.ts";
import { runVersionCheck, startPeriodicUpdateCheck, BOT_VERSION } from "./util/version-check.ts";

// Core modules - now handle most of the heavy lifting
import {
  parseArgs,
  createMessageHistory,
  createBotManagers,
  setupPeriodicCleanup,
  createBotSettings,
  createAllHandlers,
  getAllCommands,
  cleanSessionId,
  createButtonHandlers,
  createAllCommandHandlers,
  type BotManagers,
  type AllHandlers,
  type MessageHistoryOps,
} from "./core/index.ts";

// Re-export for backward compatibility
export { getGitInfo, executeGitCommand } from "./git/index.ts";
export { sendToClaudeCode } from "./claude/index.ts";

// ================================
// Bot Creation
// ================================

/**
 * Create Claude Code Discord Bot with all handlers and integrations.
 */
export async function createClaudeCodeBot(config: BotConfig) {
  const { discordToken, applicationId, workDir, repoName, branchName, categoryName, defaultMentionUserId } = config;

  // Determine category name (use repository name if not specified)
  const actualCategoryName = categoryName || repoName;

  // Claude Code session management (closures needed for handler state)
  let claudeController: AbortController | null = null;
  let claudeSessionId: string | undefined;

  // Message history for navigation
  const messageHistoryOps: MessageHistoryOps = createMessageHistory(50);

  // Create all managers using bot-factory
  const managers: BotManagers = createBotManagers({
    config: {
      discordToken,
      applicationId,
      workDir,
      categoryName: actualCategoryName,
      userId: defaultMentionUserId,
    },
    crashHandlerOptions: {
      maxRetries: 3,
      retryDelay: 5000,
      enableAutoRestart: true,
      logCrashes: true,
      notifyOnCrash: true,
      // deno-lint-ignore require-await
      onCrashNotification: async (report) => {
        console.warn(`Process crash: ${report.processType} ${report.processId || ''} - ${report.error.message}`);
      },
    },
  });

  const { shellManager, worktreeBotManager, crashHandler, healthMonitor, claudeSessionManager } = managers;

  // Initialize persistence managers (channel sessions, thread bindings, channel→project map)
  await initAllPersistence();
  const channelSessionsPersister = getChannelSessionsManager();
  const threadSessionsPersister = getThreadSessionsManager();
  const channelBindingsPersister = getChannelBindingsManager();

  // Load previously-persisted channel→session mappings so /claude resumes after restart
  const initialChannelSessions = await channelSessionsPersister.load({});

  // Per-channel project binding manager (hydrated from .bot-data/channel-bindings.json)
  const channelBindings = new ChannelBindingManager(channelBindingsPersister);
  await channelBindings.load();

  // Persona registry — loads personas/*.json presets at startup.
  // Resolves from PERSONAS_DIR env (or /app/personas in Docker, ~/claude-discord/personas otherwise).
  const personasDir = Deno.env.get("PERSONAS_DIR") ??
    (Deno.env.get("DOCKER_CONTAINER") ? "/app/personas" : `${Deno.cwd()}/personas`);
  const personaManager = new PersonaManager(personasDir);
  await personaManager.load();

  // OpenClaw delegation MCP server — built once, injected into any
  // persona that has enableOpenclaw: true. No-op when the bridge env
  // vars are unset.
  const openclawMcpServer = buildOpenclawMcpServer();
  if (openclawMcpServer) {
    console.log("[openclaw] in-process MCP server ready (enable via persona.enableOpenclaw)");
  } else {
    console.log("[openclaw] bridge not configured — OPENCLAW_BRIDGE_URL/TOKEN missing");
  }

  // Honcho user-context client — built once, used by personas with
  // enableHoncho: true for pre-query context injection + post-query
  // conversation storage. No-op when HONCHO_API_URL is unset.
  const honchoClient = buildHonchoClient();
  if (honchoClient) {
    // Ensure workspace exists at startup
    await honchoClient.ensureWorkspace();
    console.log("[honcho] client ready (enable via persona.enableHoncho)");
  } else {
    console.log("[honcho] not configured — HONCHO_API_URL missing");
  }

  // Honcho MCP tools — in-process SDK server for active user-context
  // queries (honcho_context, honcho_search, honcho_ask, honcho_remember).
  // Mutable context object is set per-query in runPromptInChannel.
  let honchoMcpContext: HonchoMcpContext = { userId: "unknown", channelId: "unknown" };
  const honchoMcpServer = honchoClient
    ? buildHonchoMcpServer(honchoClient, () => honchoMcpContext)
    : undefined;

  // Jira client + MCP — built once, injected into any persona that has
  // enableJira: true. No-op when the JIRA_* env vars are unset. Used by
  // the project-manager persona for beads-first, Jira-mirror workflow.
  const jiraClient = buildJiraClient();
  const jiraMcpServer = jiraClient ? buildJiraMcpServer(jiraClient) : undefined;
  if (jiraClient) {
    try {
      const accountId = await jiraClient.verifyAuth();
      console.log(`[jira] client ready for project ${jiraClient.config.projectKey} as accountId=${accountId.slice(0, 12)}…`);
    } catch (err) {
      console.error("[jira] auth verification failed:", err instanceof Error ? err.message : err);
    }
  } else {
    console.log("[jira] not configured — JIRA_BASE_URL/EMAIL/API_TOKEN/PROJECT_KEY missing");
  }

  // Team registry client + MCP — built once, injected into personas with
  // enableTeam: true. Reads and writes team.json via atomic file ops.
  // No-op when team.json doesn't exist at TEAM_JSON_PATH (default /app/team.json).
  const teamClient = buildTeamClient();
  const teamMcpServer = teamClient ? buildTeamMcpServer(teamClient) : undefined;
  if (teamClient) {
    try {
      const members = await teamClient.list();
      console.log(`[team] registry ready at ${teamClient.config.filePath} (${members.length} members)`);
    } catch (err) {
      console.error("[team] registry load failed:", err instanceof Error ? err.message : err);
    }
  } else {
    console.log("[team] not configured — team.json not found");
  }

  // ── Honcho × team.json bootstrap ─────────────────────────────────
  // Resolve a Discord user ID to a stable Honcho peer name. If the user
  // exists in team.json, use their team.json id (e.g. "karim", "mohamed")
  // so Honcho's deriver writes readable observations. Otherwise fall
  // back to a namespaced discord-<id> so profiles stay distinct.
  const resolveHonchoPeerId = async (discordUserId: string): Promise<string> => {
    if (!teamClient) return `discord-${discordUserId}`;
    try {
      const m = await teamClient.findByDiscordId(discordUserId);
      return m?.id ?? `discord-${discordUserId}`;
    } catch {
      return `discord-${discordUserId}`;
    }
  };

  // Seed every human in team.json as a Honcho peer with metadata + peer
  // card so multi-peer profiling has a clean starting point. Runs once
  // at startup; safe to re-run (peer creation is idempotent, card PUT
  // overwrites). No-op when either client is missing.
  if (honchoClient && teamClient) {
    try {
      const members = await teamClient.list();
      const humans = members.filter((m) => m.kind === "human");
      let seeded = 0;
      for (const m of humans) {
        const peerId = m.id;
        const metadata: Record<string, unknown> = {
          display_name: m.display_name,
          kind: m.kind,
          skills: m.skills,
          source: "team.json",
        };
        if (m.alias) metadata.alias = m.alias;
        if (m.jira_account_id) metadata.jira_account_id = m.jira_account_id;
        if (m.discord_user_id) metadata.discord_user_id = m.discord_user_id;
        if (m.notes) metadata.notes = m.notes;
        try {
          await honchoClient.getOrCreatePeer(peerId, { metadata });
          // Build a concise peer card from team.json facts — one fact per
          // line, Honcho stores these as the initial representation.
          const facts: string[] = [
            `${m.display_name}${m.alias ? ` (known as "${m.alias}")` : ""} is a ${m.kind} member of the NL-ITX workscape team.`,
          ];
          if (m.skills.length > 0) {
            facts.push(`Skills: ${m.skills.join(", ")}.`);
          }
          if (m.jira_account_id) {
            facts.push(`Jira accountId: ${m.jira_account_id}.`);
          }
          if (m.discord_user_id) {
            facts.push(`Discord user id: ${m.discord_user_id}.`);
          }
          if (m.notes) {
            facts.push(m.notes);
          }
          await honchoClient.setPeerCard(peerId, facts);
          seeded++;
        } catch (err) {
          console.warn(
            `[honcho] seed failed for peer '${peerId}': ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      console.log(`[honcho] seeded ${seeded}/${humans.length} human peer(s) from team.json`);
    } catch (err) {
      console.warn("[honcho] team.json bootstrap failed:", err instanceof Error ? err.message : err);
    }
  }

  // Initialize dynamic model fetching (uses ANTHROPIC_API_KEY if available)
  initModels();

  // Setup periodic cleanup tasks
  const cleanupInterval = setupPeriodicCleanup(managers, 3600000, [
    cleanupPaginationStates,
    () => { sessionThreadManager.cleanup(); },
  ]);

  // Initialize bot settings
  const settingsOps = createBotSettings(defaultMentionUserId, DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS);
  const currentSettings = settingsOps.getSettings();
  const botSettings = currentSettings.legacy;

  // Bot instance placeholder
  // deno-lint-ignore no-explicit-any prefer-const
  let bot: any;
  let claudeSender: ((messages: ClaudeMessage[]) => Promise<void>) | null = null;

  // Session thread manager — maps each Claude session to a dedicated Discord thread.
  // Passes a persister so thread bindings survive container restarts.
  const sessionThreadManager = new SessionThreadManager(threadSessionsPersister);
  await sessionThreadManager.loadPersisted();

  // Session thread callbacks — used by claude/command.ts for /claude-thread and /resume.
  // The callbacks are closures over `bot` (late-bound) and `sessionThreadManager`.
  const sessionThreadCallbacks: SessionThreadCallbacks = {
    async createThreadSender(prompt: string, sessionId?: string, threadName?: string) {
      const channel = bot?.getChannel() as TextChannel | null;
      if (!channel) throw new Error('Bot channel not ready');

      // If a session ID was provided, check for an existing thread to reuse
      if (sessionId) {
        const existingThread = sessionThreadManager.getThread(sessionId);
        if (existingThread) {
          if (existingThread.archived) {
            await existingThread.setArchived(false);
          }
          sessionThreadManager.recordActivity(sessionId);
          const threadSender = createClaudeSender(createChannelSenderAdapter(existingThread));
          return { sender: threadSender, threadSessionKey: sessionId, threadChannelId: existingThread.id };
        }
      }

      // Generate a placeholder key until the real SDK session ID arrives
      const placeholderKey = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Create a thread in the main channel
      const thread = await sessionThreadManager.createSessionThread(channel, placeholderKey, prompt, threadName);

      // Post a summary embed in the main channel pointing to the thread
      await sendMessageContent(channel, {
        embeds: [{
          color: 0x5865F2,
          title: '🧵 New Claude Session',
          description: `A new session thread has been created.\n\n**Prompt:** \`${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}\``,
          fields: [
            { name: 'Thread', value: `<#${thread.id}>`, inline: true },
          ],
          timestamp: true,
        }],
      });

      const threadSender = createClaudeSender(createChannelSenderAdapter(thread));
      return { sender: threadSender, threadSessionKey: placeholderKey, threadChannelId: thread.id };
    },

    async getThreadSender(sessionId: string) {
      const existingThread = sessionThreadManager.getThread(sessionId);
      if (!existingThread) return undefined;

      if (existingThread.archived) {
        await existingThread.setArchived(false);
      }
      sessionThreadManager.recordActivity(sessionId);
      const threadSender = createClaudeSender(createChannelSenderAdapter(existingThread));
      return { sender: threadSender, threadSessionKey: sessionId };
    },

    updateSessionId(oldKey: string, newSessionId: string) {
      sessionThreadManager.updateSessionId(oldKey, newSessionId);
    },
  };

  // Late-bound AskUserQuestion handler — set after bot is created.
  // When Claude needs clarification mid-session, this sends buttons to Discord
  // and waits for the user's click.
  // Uses an object wrapper so TypeScript doesn't narrow the closure to `never`.
  const askUserState: { handler: ((input: AskUserQuestionInput) => Promise<Record<string, string>>) | null } = { handler: null };

  // Late-bound PermissionRequest handler — set after bot is created.
  // When Claude wants to use a tool that isn't pre-approved, this shows
  // Allow/Deny buttons in Discord and returns the user's decision.
  const permReqState: { handler: PermissionRequestCallback | null } = { handler: null };

  // Create sendClaudeMessages function that uses the sender when available
  const sendClaudeMessages = async (messages: ClaudeMessage[]) => {
    if (claudeSender) {
      await claudeSender(messages);
    }
  };

  // Create onAskUser wrapper — delegates to askUserState.handler once bot is ready
  const onAskUser = async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    if (!askUserState.handler) {
      throw new Error('AskUserQuestion handler not initialized — bot not ready');
    }
    return await askUserState.handler(input);
  };

  // Create onPermissionRequest wrapper — delegates to permReqState.handler once bot is ready
  const onPermissionRequest: PermissionRequestCallback = async (toolName, toolInput) => {
    if (!permReqState.handler) {
      console.warn('[PermissionRequest] Handler not initialized — auto-denying');
      return false;
    }
    return await permReqState.handler(toolName, toolInput);
  };

  // Create all handlers using the registry (centralized handler creation)
  const allHandlers: AllHandlers = createAllHandlers(
    {
      workDir,
      repoName,
      branchName,
      categoryName: actualCategoryName,
      discordToken,
      applicationId,
      defaultMentionUserId,
      shellManager,
      worktreeBotManager,
      crashHandler,
      healthMonitor,
      claudeSessionManager,
      sendClaudeMessages,
      onAskUser,
      onPermissionRequest,
      onBotSettingsUpdate: (settings) => {
        botSettings.mentionEnabled = settings.mentionEnabled;
        botSettings.mentionUserId = settings.mentionUserId;
        if (bot) {
          bot.updateBotSettings(settings);
        }
      },
      sessionThreads: sessionThreadCallbacks,
      initialChannelSessions,
      persistChannelSessions: (snapshot) => {
        channelSessionsPersister
          .save(snapshot)
          .catch((err) => console.error('[index] persistChannelSessions failed:', err));
      },
      getWorkDirForChannel: (channelId) => channelBindings.getWorkDir(channelId),
    },
    {
      getController: () => claudeController,
      setController: (controller) => { claudeController = controller; },
      getSessionId: () => claudeSessionId,
      setSessionId: (sessionId) => { claudeSessionId = sessionId; },
    },
    settingsOps
  );

  // Create command handlers using the wrapper factory
  const handlers: CommandHandlers = createAllCommandHandlers({
    handlers: allHandlers,
    messageHistory: messageHistoryOps,
    getClaudeController: () => claudeController,
    getClaudeSessionId: () => claudeSessionId,
    crashHandler,
    healthMonitor,
    botSettings,
    cleanupInterval,
    bindCommandHandlers: createBindCommandHandlers({
      channelBindings,
      globalWorkDir: workDir,
      onWorkDirChanged: (channelId) => {
        allHandlers.claude.setSessionForChannel(channelId, undefined);
      },
    }),
    personaCommandHandlers: createPersonaCommandHandlers({
      personaManager,
      channelBindings,
      globalWorkDir: workDir,
      onPersonaChanged: (channelId) => {
        // Clear any cached session so the next message starts fresh with
        // the new persona's MCP tools and system prompt.
        allHandlers.claude.setSessionForChannel(channelId, undefined);
      },
    }),
    sessionCommandHandlers: createSessionCommandHandlers({
      channelBindings,
      personaManager,
      getSessionForChannel: allHandlers.claude.getSessionForChannel,
      setSessionForChannel: allHandlers.claude.setSessionForChannel,
      globalWorkDir: workDir,
    }),
    honchoCommandHandlers: honchoClient
      ? createHonchoCommandHandlers({
          apiUrl: Deno.env.get("HONCHO_API_URL") ?? "http://honcho-api:8000",
          workspaceId: Deno.env.get("HONCHO_WORKSPACE_ID") ?? "discord-bot",
        })
      : undefined,
  });

  // Create button handlers using the button handler factory
  const buttonHandlers: ButtonHandlers = createButtonHandlers(
    {
      messageHistory: messageHistoryOps,
      handlers: allHandlers,
      getClaudeSessionId: () => claudeSessionId,
      sendClaudeMessages,
      workDir,
    },
    expandableContent
  );

  // Channel monitoring for auto-responding to bot/webhook messages
  const monitorChannelId = Deno.env.get("MONITOR_CHANNEL_ID");
  const monitorBotIds = Deno.env.get("MONITOR_BOT_IDS")?.split(",").map(s => s.trim()).filter(Boolean);

  // Parse ALLOWED_CHANNEL_IDS env var — comma-separated Discord channel/forum IDs
  // in which the bot accepts commands beyond its auto-created main channel.
  const allowedChannelIdsRaw = Deno.env.get("ALLOWED_CHANNEL_IDS") ?? "";
  const allowedChannelIds = new Set(
    allowedChannelIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (allowedChannelIds.size > 0) {
    console.log(`[index] ALLOWED_CHANNEL_IDS: ${allowedChannelIds.size} channel(s) allowed`);
  }

  /**
   * A channel/thread is in "quiet" mode when it's inside a Discord Forum —
   * users chat conversationally there and don't want tool-use chatter or
   * colored embeds. We detect by walking up to the parent channel.
   */
  // deno-lint-ignore no-explicit-any
  const isForumContext = (channel: any): boolean => {
    const parent = channel?.parent;
    if (!parent) return false;
    if (parent.type === ChannelType.GuildForum) return true;
    // Thread nested under a channel whose own parent is a forum (unusual but possible).
    return parent.parent?.type === ChannelType.GuildForum;
  };

  /**
   * Build a Claude-CLI-style subtext footer. Discord renders leading `-# ` as
   * small dim text, so this reads as a status strip under the reply.
   */
  const buildFooter = (r: {
    sessionId?: string;
    modelUsed?: string;
    duration?: number;
    cost?: number;
  }): string => {
    const parts: string[] = [];
    if (r.sessionId) parts.push(`session \`${r.sessionId.slice(0, 8)}\``);
    if (r.modelUsed && r.modelUsed !== 'Default') parts.push(r.modelUsed);
    if (typeof r.duration === 'number') parts.push(`${(r.duration / 1000).toFixed(1)}s`);
    if (typeof r.cost === 'number' && r.cost > 0) parts.push(`$${r.cost.toFixed(4)}`);
    return parts.length > 0 ? `-# ${parts.join(' · ')}` : '';
  };

  // Shared helper: run a prompt against Claude scoped to a specific channel.
  // Resolves the channel's bound workDir (falling back to global), resumes an
  // existing session if one exists, otherwise starts a fresh one. Streams
  // output back via a sender bound to the given Discord channel/thread.
  // In forum contexts uses a plain-markdown "quiet" sender and appends a
  // CLI-style subtext footer with session_id / model / duration / cost.
  const runPromptInChannel = async (
    // deno-lint-ignore no-explicit-any
    channel: any,
    channelId: string,
    prompt: string,
    opts: {
      /** Override quiet detection. Default: derived from forum-context check. */
      quiet?: boolean;
      /** Message to react ⏳/✅ on for visual ack. */
      // deno-lint-ignore no-explicit-any
      triggerMessage?: any;
      /** Fires with the raw Claude response text. Used by the voice-query
       *  HTTP endpoint to capture the response for TTS playback, since the
       *  function itself still returns sessionId to preserve existing
       *  text-channel callers. */
      onResponse?: (text: string) => void;
      /** Extra system prompt text appended to whatever the persona sets.
       *  Used by voice queries to inject TTS-friendliness instructions
       *  (English-only, plain text, no emoji) per-call without changing
       *  the persona preset. */
      extraSystemPrompt?: string;
    } = {},
  ): Promise<string | undefined> => {
    // If channel has no binding (no workDir, no persona), show the
    // interactive setup wizard instead of running a query. The wizard
    // asks the user to pick a workspace + persona, then auto-configures.
    // Forum threads with unbound parents also get the wizard — forum
    // channels have no text surface, so the wizard fires in the post.
    if (!channelBindings.has(channelId)) {
      const userId = opts.triggerMessage?.author?.id ?? "unknown";
      const shown = await runSetupWizard(
        {
          channelBindings,
          personaManager,
          workspacesRoot: "/workspaces/projects",
          globalWorkDir: workDir,
          onSetupComplete: (cid) => {
            allHandlers.claude.setSessionForChannel(cid, undefined);
          },
        },
        channel,
        channelId,
        userId,
      );
      if (shown) return undefined; // wizard consumed the message
    }

    const quiet = opts.quiet ?? isForumContext(channel);
    const binding = channelBindings.get(channelId);
    const channelWorkDir = binding?.workDir ?? workDir;
    const existingSessionId = allHandlers.claude.getSessionForChannel(channelId);
    const adapter = createChannelSenderAdapter(channel);
    const sender = quiet ? createQuietClaudeSender(adapter) : createClaudeSender(adapter);
    const controller = new AbortController();

    // Resolve the persona (if any) attached to this channel and merge its
    // fields into the ClaudeModelOptions. Anything the persona doesn't
    // set falls through to bot/global defaults.
    const persona = binding?.personaName ? personaManager.get(binding.personaName) : undefined;
    const modelOptions: ClaudeModelOptions = persona
      ? mergePersonaIntoOptions({}, persona)
      : {};

    // Ambient / forum messages run under YOLO trust by default — the user
    // explicitly chose full-access mode for this bot. dontAsk blocks MCP
    // tools pre-emptively (Claude self-censors) which breaks openclaw and
    // WebFetch-style delegation. Persona can override.
    if (!modelOptions.permissionMode) {
      modelOptions.permissionMode = "bypassPermissions";
    }

    // Caller-supplied extra system prompt (e.g. voice query adds
    // TTS-friendliness instructions).
    if (opts.extraSystemPrompt) {
      modelOptions.appendSystemPrompt = modelOptions.appendSystemPrompt
        ? `${modelOptions.appendSystemPrompt}\n\n${opts.extraSystemPrompt}`
        : opts.extraSystemPrompt;
    }

    // Inject the in-process OpenClaw MCP server when the persona opts in.
    if (persona?.enableOpenclaw && openclawMcpServer) {
      modelOptions.mcpServers = {
        ...(modelOptions.mcpServers ?? {}),
        openclaw: openclawMcpServer,
      };
    }

    // Inject the in-process Jira MCP server when the persona opts in.
    if (persona?.enableJira && jiraMcpServer) {
      modelOptions.mcpServers = {
        ...(modelOptions.mcpServers ?? {}),
        jira: jiraMcpServer,
      };
    }

    // Inject the in-process team registry MCP server when the persona opts in.
    if (persona?.enableTeam && teamMcpServer) {
      modelOptions.mcpServers = {
        ...(modelOptions.mcpServers ?? {}),
        team: teamMcpServer,
      };
    }

    // ── Per-message identity header (NOT system prompt) ──
    // The Claude Agent SDK caches the system prompt at session creation,
    // so anything we append there is frozen at whoever started the session.
    // In a multi-user channel, a stale system-prompt identity makes the
    // persona misidentify every follow-up sender. Instead, we prepend a
    // fresh <msg_sender> tag to the user prompt itself — the prompt is
    // always sent as a new turn, never cached.
    const triggerUserId = opts.triggerMessage?.author?.id ?? "unknown";
    const triggerUserTag = opts.triggerMessage?.author?.tag
      ?? opts.triggerMessage?.author?.username
      ?? "unknown";
    let effectivePrompt = prompt;
    if (persona?.enableTeam && triggerUserId !== "unknown") {
      const senderTag =
        `<msg_sender discord_user_id="${triggerUserId}" ` +
        `discord_username="${triggerUserTag}" channel_id="${channelId}" />\n\n`;
      effectivePrompt = `${senderTag}${prompt}`;
    }

    // ── Honcho: resolve stable peer id + peer-scoped context pull ──
    // Discord ID → team.json id (when known) → Honcho peer name. This
    // gives readable peer names in Honcho observations AND ensures that
    // seed / message / context all target the same peer, so multi-human
    // sessions don't blend one person's profile into another's.
    const honchoUserId = opts.triggerMessage?.author?.id ?? "unknown";
    const tPhase_honchoResolve = Date.now();
    const honchoPeerId = honchoUserId !== "unknown" && honchoClient
      ? await resolveHonchoPeerId(honchoUserId)
      : honchoUserId;
    const honchoResolveMs = Date.now() - tPhase_honchoResolve;
    if (persona?.enableHoncho && honchoMcpServer && honchoUserId !== "unknown") {
      honchoMcpContext = { userId: honchoPeerId, channelId };
      modelOptions.mcpServers = {
        ...(modelOptions.mcpServers ?? {}),
        honcho: honchoMcpServer,
      };
    }
    const tPhase_honchoPre = Date.now();
    if (persona?.enableHoncho && honchoClient && honchoUserId !== "unknown") {
      try {
        // Ensure the peer exists. When team.json knows this Discord user,
        // we'll seed metadata; otherwise create a bare peer so new users
        // still get tracked distinctly.
        if (teamClient) {
          const member = await teamClient.findByDiscordId(honchoUserId);
          if (member) {
            const metadata: Record<string, unknown> = {
              display_name: member.display_name,
              kind: member.kind,
              skills: member.skills,
              source: "team.json",
            };
            if (member.alias) metadata.alias = member.alias;
            if (member.jira_account_id) metadata.jira_account_id = member.jira_account_id;
            if (member.discord_user_id) metadata.discord_user_id = member.discord_user_id;
            await honchoClient.getOrCreatePeer(honchoPeerId, { metadata });
          } else {
            await honchoClient.getOrCreatePeer(honchoPeerId, {
              metadata: {
                source: "discord-auto",
                discord_user_id: honchoUserId,
                discord_username: triggerUserTag,
              },
            });
          }
        } else {
          await honchoClient.getOrCreatePeer(honchoPeerId);
        }
        await honchoClient.getOrCreateSession(channelId, {
          [honchoPeerId]: { observe_me: true, observe_others: false },
          "claude-bot": { observe_me: false, observe_others: true },
        });
        // Peer-scoped context fetch — level-1 fix. When peer_target is
        // set, the response contains peer_representation + peer_card
        // scoped to this peer only, not a session-wide blend.
        const ctx = await honchoClient.getContext(channelId, { peerTarget: honchoPeerId });
        const parts: string[] = [];
        if (ctx.peer_representation) parts.push(`User profile: ${ctx.peer_representation}`);
        if (ctx.peer_card) parts.push(`User card: ${ctx.peer_card}`);
        if (ctx.summary) parts.push(`Session summary: ${ctx.summary}`);
        if (parts.length > 0) {
          const contextBlock = `\n\n<honcho_user_context peer=\"${honchoPeerId}\">\n${parts.join("\n\n")}\n</honcho_user_context>`;
          modelOptions.appendSystemPrompt = modelOptions.appendSystemPrompt
            ? `${modelOptions.appendSystemPrompt}${contextBlock}`
            : contextBlock;
        }
      } catch (err) {
        console.warn("[honcho] pre-query context failed:", err instanceof Error ? err.message : err);
      }
    }
    const honchoPreMs = Date.now() - tPhase_honchoPre;

    // Attach dashboard-forwarding hooks (fires fire-and-forget HTTP POSTs
    // to agent-monitor + agents-observe sidecars). No-op if disabled.
    const dashHooks = buildDashboardHooks(getDashboardEndpoints(), {
      channelId,
      personaName: binding?.personaName,
    });
    modelOptions.hooks = mergeHooks(modelOptions.hooks, dashHooks);

    // Visual ack: ⏳ on user's message. Best-effort, never throws.
    const react = async (emoji: string) => {
      try { await opts.triggerMessage?.react?.(emoji); } catch { /* ignore */ }
    };
    await react('⏳');
    try { await channel.sendTyping?.(); } catch { /* ignore */ }

    try {
      const tPhase_sdk = Date.now();
      const result = await sendToClaudeCode(
        channelWorkDir,
        effectivePrompt,
        controller,
        existingSessionId,
        undefined,
        (jsonData) => {
          const msgs = convertToClaudeMessages(jsonData);
          if (msgs.length > 0) sender(msgs).catch(() => {});
        },
        false,
        modelOptions,
      );
      const sdkMs = Date.now() - tPhase_sdk;
      // One-line phase breakdown so we can see where time is going.
      console.log(
        `[runPromptInChannel] phases: honcho-resolve=${honchoResolveMs}ms honcho-pre=${honchoPreMs}ms ` +
        `sdk=${sdkMs}ms persona=${persona?.name ?? "none"} resumed=${Boolean(existingSessionId)}`,
      );
      if (result.sessionId) {
        allHandlers.claude.setSessionForChannel(channelId, result.sessionId);
      }

      // Bubble the response text up via optional callback (used by voice).
      if (opts.onResponse && result.response) {
        try { opts.onResponse(result.response); } catch { /* ignore */ }
      }

      // ── Honcho post-query: store conversation turn (fire-and-forget) ──
      // Attribute the user turn to the RESOLVED peer id (team.json id when
      // known, otherwise discord-<snowflake>) so it lands on the same
      // peer card the pre-query fetch is reading from.
      if (persona?.enableHoncho && honchoClient && result.response && honchoUserId !== "unknown") {
        const botPeerId = "claude-bot";
        void (async () => {
          try {
            await honchoClient.getOrCreatePeer(botPeerId, {
              metadata: { display_name: "Claude Bot", kind: "agent", source: "system" },
            });
            await honchoClient.addMessages(channelId, [
              { content: prompt, peer_id: honchoPeerId },
              { content: result.response.slice(0, 25000), peer_id: botPeerId },
            ]);
          } catch (err) {
            console.warn("[honcho] post-query store failed:", err instanceof Error ? err.message : err);
          }
        })();
      }

      if (quiet) {
        const footer = buildFooter(result);
        if (footer) {
          try { await channel.send({ content: footer }); } catch { /* ignore */ }
        }
      }
      await react('✅');
      return result.sessionId;
    } catch (err) {
      console.error(`[runPromptInChannel] query failed for channel ${channelId}:`, err);
      await react('❌');
      return undefined;
    }
  };

  // Track recently-created forum threads so the ambient MessageCreate handler
  // doesn't also process the starter message (ThreadCreate already handles it).
  const recentForumThreadIds = new Set<string>();

  // Forum thread handler — spawns a fresh Claude session for each new forum
  // post in a managed forum channel.
  //
  // If the parent forum IS bound → thread inherits workDir + persona, runs
  // the post body as the first query immediately (clean, automatic).
  //
  // If the parent forum is NOT bound → thread is left unbound so
  // runPromptInChannel's setup wizard fires in the thread. The user picks
  // a workspace + persona from dropdowns, then resends their message.
  // (Forum channels have no text surface, so the wizard must fire here.)
  const onForumThreadCreated = async (thread: {
    id: string;
    parentId: string | null;
    name: string;
    fetchStarterMessage: () => Promise<{ content: string } | null>;
    send: (content: unknown) => Promise<unknown>;
  }) => {
    const parentId = thread.parentId;
    if (!parentId) return;

    // Mark this thread as just-created so the ambient MessageCreate handler
    // skips the starter message (we handle it here). Clear after 30s.
    recentForumThreadIds.add(thread.id);
    setTimeout(() => recentForumThreadIds.delete(thread.id), 30_000);

    const parentBinding = channelBindings.get(parentId);

    // Register the thread in SessionThreadManager (for both paths).
    const placeholderKey = `pending_forum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // deno-lint-ignore no-explicit-any
    sessionThreadManager.registerExistingThread(thread as any, placeholderKey, thread.name);

    if (parentBinding) {
      // ── Parent is bound → inherit and auto-run ──
      await channelBindings.set(thread.id, {
        ...parentBinding,
        boundAt: new Date().toISOString(),
        boundBy: "forum-auto",
        label: `forum: ${thread.name}`,
      });

      let starterContent = "";
      // deno-lint-ignore no-explicit-any
      let starterMessage: any = null;
      try {
        starterMessage = await thread.fetchStarterMessage();
        starterContent = starterMessage?.content?.trim() ?? "";
      } catch { /* ignore */ }

      if (starterContent) {
        const sessionId = await runPromptInChannel(thread, thread.id, starterContent, {
          triggerMessage: starterMessage,
        });
        if (sessionId) {
          sessionThreadManager.updateSessionId(placeholderKey, sessionId);
        }
      } else {
        // deno-lint-ignore no-explicit-any
        try { await (thread as any).send?.({ content: `-# 🧵 session ready · workDir \`${parentBinding.workDir}\`` }); } catch { /* ignore */ }
      }
    } else {
      // ── Parent is NOT bound → let the wizard handle it ──
      // Fetch the starter message so we can extract the author for the wizard.
      // deno-lint-ignore no-explicit-any
      let starterMessage: any = null;
      try {
        starterMessage = await thread.fetchStarterMessage();
      } catch { /* ignore */ }

      const authorId = starterMessage?.author?.id ?? "unknown";
      const starterContent = starterMessage?.content?.trim() ?? "";

      // Show the setup wizard in the thread.
      const wizardShown = await runSetupWizard(
        {
          channelBindings,
          personaManager,
          workspacesRoot: "/workspaces/projects",
          globalWorkDir: workDir,
          onSetupComplete: (cid) => {
            allHandlers.claude.setSessionForChannel(cid, undefined);
          },
        },
        // deno-lint-ignore no-explicit-any
        thread as any,
        thread.id,
        authorId,
      );

      if (wizardShown && starterContent) {
        // After wizard, the thread IS bound. Notify user to resend.
        // (We can't auto-replay because the wizard is async + interactive.)
        // deno-lint-ignore no-explicit-any
        try { await (thread as any).send?.({ content: `-# Setup complete. Resend your message to start the session.` }); } catch { /* ignore */ }
      }
    }
  };

  // Ambient-message handler — plain messages in managed channels continue or
  // start a Claude session for that channel without any /claude prefix.
  const onChannelMessage = async (message: {
    channelId: string;
    // deno-lint-ignore no-explicit-any
    channel: any;
    content: string;
  }) => {
    // Skip if this is the starter message of a just-created forum thread —
    // onForumThreadCreated already handled it (or showed the wizard).
    if (recentForumThreadIds.has(message.channelId)) return;

    await runPromptInChannel(
      message.channel,
      message.channelId,
      message.content,
      { triggerMessage: message },
    );
  };

  // Create dependencies object for Discord bot
  const dependencies: BotDependencies = {
    commands: getAllCommands(),
    cleanSessionId,
    botSettings,
    allowedChannelIds,
    isChannelBound: (channelId) => channelBindings.has(channelId),
    // deno-lint-ignore no-explicit-any
    onForumThreadCreated: onForumThreadCreated as any,
    // deno-lint-ignore no-explicit-any
    onChannelMessage: onChannelMessage as any,
    onThreadRemoved: async (threadId, reason) => {
      console.log(`[index] thread ${reason}: ${threadId} — cleaning up session + binding`);

      // Capture details before cleanup for the notification.
      const binding = channelBindings.get(threadId);
      const sessionId = allHandlers.claude.getSessionForChannel(threadId);
      const threadMeta = sessionThreadManager.getSessionThread(
        sessionThreadManager.findSessionByThreadId(threadId) ?? "",
      );

      // Clean up session, binding, and thread-manager state.
      allHandlers.claude.setSessionForChannel(threadId, undefined);
      await channelBindings.delete(threadId);
      sessionThreadManager.removeByThreadId(threadId);

      // Notify the main channel (same style as startup/shutdown embeds).
      try {
        const mainChannel = bot?.getChannel();
        if (mainChannel) {
          await sendMessageContent(mainChannel, {
            embeds: [{
              color: reason === 'deleted' ? 0xff0000 : 0xffa500,
              title: reason === 'deleted'
                ? '🗑️ Thread deleted — session cleaned up'
                : '📦 Thread archived — session cleaned up',
              fields: [
                { name: 'Thread', value: threadMeta?.threadName ?? threadId, inline: true },
                { name: 'Reason', value: reason, inline: true },
                ...(binding?.workDir ? [{ name: 'Workspace', value: `\`${binding.workDir}\``, inline: true }] : []),
                ...(binding?.personaName ? [{ name: 'Persona', value: binding.personaName, inline: true }] : []),
                ...(sessionId ? [{ name: 'Session', value: `\`${sessionId.slice(0, 8)}…\``, inline: true }] : []),
              ],
              timestamp: true,
            }],
          });
        }
      } catch (err) {
        console.error('[index] failed to send thread-removal notification:', err);
      }
    },
    onContinueSession: async (ctx) => {
      await allHandlers.claude.onContinue(ctx);
    },
    ...(monitorChannelId && monitorBotIds?.length && {
      monitorConfig: {
        channelId: monitorChannelId,
        botIds: monitorBotIds,
        onAlertMessage: async (content: string, thread: TextChannel) => {
          const prompt = [
            "A monitoring alert notification was just received. Investigate this alert.",
            "Identify the alert, check severity, gather diagnostics, analyze the root cause, and report findings.",
            "If a config change is needed, describe what should change. If it's a transient issue, report findings.",
            "",
            "Alert content:",
            content,
          ].join("\n");

          // Create a sender bound to the alert thread, not the bot's main channel
          const threadSender = createClaudeSender(createChannelSenderAdapter(thread));

          const controller = new AbortController();
          await sendToClaudeCode(
            workDir,
            prompt,
            controller,
            undefined,
            undefined,
            (jsonData) => {
              const claudeMessages = convertToClaudeMessages(jsonData);
              if (claudeMessages.length > 0) {
                threadSender(claudeMessages).catch(() => {});
              }
            },
            false,
          );
        },
      },
    }),
  };

  // Create Discord bot
  bot = await createDiscordBot(config, handlers, buttonHandlers, dependencies, crashHandler);

  // Restore ThreadChannel references for loaded session threads once the
  // Discord client is ready. Runs immediately if the client is already ready.
  const restoreThreadChannels = async () => {
    try {
      await sessionThreadManager.restoreChannels(bot.client);
    } catch (err) {
      console.error('[index] Failed to restore session thread channels:', err);
    }
  };
  if (bot.client.isReady()) {
    restoreThreadChannels();
  } else {
    bot.client.once(Events.ClientReady, restoreThreadChannels);
  }

  // Create Discord sender for Claude messages
  claudeSender = createClaudeSender(createDiscordSenderAdapter(bot));

  // Helper: resolve the target channel for the currently active session.
  // If there's an active session thread, use that; otherwise fall back to main channel.
  const getActiveSessionChannel = () => {
    // Try to find the thread for the current session
    if (claudeSessionId) {
      const thread = sessionThreadManager.getThread(claudeSessionId);
      if (thread) return thread;
    }
    // Also check for any pending (placeholder-keyed) threads
    const allThreads = sessionThreadManager.getAllSessionThreads();
    for (const meta of allThreads) {
      if (meta.sessionId.startsWith('pending_')) {
        const thread = sessionThreadManager.getThread(meta.sessionId);
        if (thread) return thread;
      }
    }
    return bot.getChannel();
  };

  // Initialize AskUserQuestion handler — sends questions to Discord, waits for button clicks
  askUserState.handler = createAskUserDiscordHandler(bot, getActiveSessionChannel);

  // Initialize PermissionRequest handler — shows Allow/Deny buttons for unapproved tools
  permReqState.handler = createPermissionRequestHandler(bot, getActiveSessionChannel);

  // Check for updates (non-blocking)
  runVersionCheck().then(async ({ updateAvailable, embed }) => {
    if (updateAvailable && embed) {
      const channel = bot.getChannel();
      if (channel) {
        const { EmbedBuilder } = await import("npm:discord.js@14.14.1");
        const discordEmbed = new EmbedBuilder()
          .setColor(embed.color)
          .setTitle(embed.title)
          .setDescription(embed.description)
          .setTimestamp();
        embed.fields.forEach(f => discordEmbed.addFields(f));
        await channel.send({ embeds: [discordEmbed] });
      }
    }
  }).catch(() => { /* version check is best-effort */ });

  // Start periodic update checks (every 12 hours)
  startPeriodicUpdateCheck(async (result) => {
    try {
      const channel = bot.getChannel();
      if (channel) {
        const { EmbedBuilder } = await import("npm:discord.js@14.14.1");
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle("🔄 Update Available")
          .setDescription(`A newer version is available. You are running **v${BOT_VERSION}** (\`${result.localCommit}\`).`)
          .addFields(
            { name: "Latest Commit", value: `\`${result.remoteCommit}\``, inline: true },
            {
              name: "How to Update",
              value: Deno.env.get("DOCKER_CONTAINER")
                ? "```\ndocker compose pull && docker compose up -d\n```"
                : "```\ngit pull origin main && deno task start\n```",
              inline: false
            }
          )
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    } catch {
      // Periodic notification is best-effort
    }
  });

  // ── Voice query HTTP server ──────────────────────────────────────
  // Small HTTP server for the voice-worker sidecar to POST transcribed
  // speech into. Reuses the same runPromptInChannel pipeline that handles
  // ambient text messages, so voice turns get persona + Honcho + Jira +
  // team.json for free. Bound to 0.0.0.0:8300 so the sibling container
  // can reach it via the claude-network bridge at claude-bot:8300.
  const voiceQueryPort = Number(Deno.env.get("VOICE_QUERY_PORT") ?? "8300");
  const voiceQueryToken = Deno.env.get("BOT_QUERY_TOKEN") ?? "";
  const voiceDefaultPersona = Deno.env.get("VOICE_PERSONA") ?? "memory-enhanced";
  Deno.serve(
    { port: voiceQueryPort, hostname: "0.0.0.0", onListen: ({ hostname, port }) => {
      console.log(`[voice-query] HTTP server listening on ${hostname}:${port} (persona=${voiceDefaultPersona})`);
    }},
    async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", persona: voiceDefaultPersona }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.method === "POST" && url.pathname === "/voice/query") {
        try {
          // Optional bearer token check
          if (voiceQueryToken) {
            const auth = req.headers.get("authorization") ?? "";
            if (auth !== `Bearer ${voiceQueryToken}`) {
              return new Response("unauthorized", { status: 401 });
            }
          }
          // deno-lint-ignore no-explicit-any
          const body = await req.json() as any;
          const text: string = body.text ?? "";
          const discordUserId: string = body.discord_user_id ?? "unknown";
          const discordUsername: string = body.discord_username ?? "voice-user";
          const voiceChannelId: string = body.voice_channel_id ?? "voice-default";
          if (!text.trim()) {
            return new Response(JSON.stringify({ error: "empty text" }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          // Ensure the voice channel's binding matches the current
          // VOICE_PERSONA env. Always-overwrite (not just on first hit)
          // so an operator can flip VOICE_PERSONA and restart to change
          // which persona voice turns run under — without manual /bind.
          const existingBinding = channelBindings.get(voiceChannelId);
          if (
            !existingBinding ||
            existingBinding.personaName !== voiceDefaultPersona ||
            existingBinding.workDir !== workDir
          ) {
            await channelBindings.set(voiceChannelId, {
              workDir: workDir,
              personaName: voiceDefaultPersona,
            });
            allHandlers.claude.setSessionForChannel(voiceChannelId, undefined);
            console.log(`[voice-query] (re)bound ${voiceChannelId} → persona=${voiceDefaultPersona}, workDir=${workDir} (session cleared)`);
          }

          // Stateless voice mode: clear the session id BEFORE each query
          // so the SDK doesn't waste 1+ second replaying history. Each
          // voice turn becomes a fresh session. Trade-off is loss of
          // conversational continuity, which is acceptable for the voice
          // channel's chat-style use case. Toggle with VOICE_STATELESS=0.
          if (Deno.env.get("VOICE_STATELESS") !== "0") {
            allHandlers.claude.setSessionForChannel(voiceChannelId, undefined);
          }
          // Build a synthetic trigger message that carries the Discord
          // user ID through the normal identity-resolution path.
          const syntheticTrigger = {
            author: { id: discordUserId, tag: discordUsername, username: discordUsername },
            react: async () => { /* no-op for voice */ },
          };
          // Call the exact same path ambient text messages take. Capture
          // response by intercepting the stub channel.send() calls — the
          // sender pipeline writes finalized message content there, which
          // is more reliable than the result.response field (which can be
          // empty even when Claude produced text output via streaming).
          console.log(`[voice-query] incoming text="${text.slice(0,60)}" from=${discordUsername}(${discordUserId})`);
          const tRun = Date.now();
          const captured: string[] = [];
          await runPromptInChannel(
            // deno-lint-ignore no-explicit-any
            {
              send: async (msg: unknown) => {
                // deno-lint-ignore no-explicit-any
                const raw = typeof msg === "string" ? msg : ((msg as any)?.content ?? "");
                if (typeof raw !== "string" || !raw) return;
                // Skip the session footer ("-# session abc · sonnet · 3.2s · $0.01")
                // and any pure-formatting lines.
                if (raw.startsWith("-# session ")) return;
                captured.push(raw);
              },
              sendTyping: async () => {},
            } as any,
            voiceChannelId,
            text,
            {
              quiet: true,
              // deno-lint-ignore no-explicit-any
              triggerMessage: syntheticTrigger as any,
              extraSystemPrompt:
                "## Voice channel mode\n" +
                "You are speaking through a text-to-speech engine into a Discord voice channel. " +
                "Follow these rules STRICTLY, overriding any other formatting instructions:\n" +
                "- **Always reply in English**, regardless of what language the speaker used. Do not translate, just respond naturally in English.\n" +
                "- Use **plain text only**. No markdown, no code blocks, no bullet lists, no headings, no bold/italic.\n" +
                "- **Never use emoji or emoticons.** They will be read literally by the TTS and sound wrong.\n" +
                "- Keep responses **short and conversational** — ideally 1-2 sentences, max 3. Long paragraphs are painful to listen to.\n" +
                "- Write numbers as digits (e.g. '5', not 'five') unless the word form is clearer.\n" +
                "- Expand acronyms the first time unless they're already famous (NASA, API, etc.).\n" +
                "- Do not preface responses with greetings unless the user greets you first.",
            },
          );
          const finalResponse = captured.join("\n").trim();
          const runMs = Date.now() - tRun;
          console.log(`[voice-query] done runPromptInChannel=${runMs}ms captured=${captured.length} len=${finalResponse.length}`);
          return new Response(JSON.stringify({ response: finalResponse }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[voice-query] handler error:", msg);
          return new Response(JSON.stringify({ error: msg }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response("not found", { status: 404 });
    },
  );

  // Setup signal handlers for graceful shutdown
  setupSignalHandlers({
    managers,
    allHandlers,
    getClaudeController: () => claudeController,
    claudeSender,
    actualCategoryName,
    repoName,
    branchName,
    cleanupInterval,
    // deno-lint-ignore no-explicit-any
    bot: bot as any,
  });

  return bot;
}

// ================================
// Helper Functions
// ================================

/**
 * Build a Discord.js payload from a MessageContent object and send it to a channel.
 */
// deno-lint-ignore no-explicit-any
async function sendMessageContent(channel: any, content: MessageContent): Promise<void> {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("npm:discord.js@14.14.1");

  // deno-lint-ignore no-explicit-any
  const payload: any = {};

  if (content.content) payload.content = content.content;

  if (content.embeds) {
    payload.embeds = content.embeds.map(e => {
      const embed = new EmbedBuilder();
      if (e.color !== undefined) embed.setColor(e.color);
      if (e.title) embed.setTitle(e.title);
      if (e.description) embed.setDescription(e.description);
      if (e.fields) e.fields.forEach(f => embed.addFields(f));
      if (e.footer) embed.setFooter(e.footer);
      if (e.timestamp) embed.setTimestamp();
      return embed;
    });
  }

  if (content.components) {
    payload.components = content.components.map(row => {
      // deno-lint-ignore no-explicit-any
      const actionRow = new ActionRowBuilder<any>();
      row.components.forEach(comp => {
        const button = new ButtonBuilder()
          .setCustomId(comp.customId)
          .setLabel(comp.label);

        switch (comp.style) {
          case 'primary': button.setStyle(ButtonStyle.Primary); break;
          case 'secondary': button.setStyle(ButtonStyle.Secondary); break;
          case 'success': button.setStyle(ButtonStyle.Success); break;
          case 'danger': button.setStyle(ButtonStyle.Danger); break;
          case 'link': button.setStyle(ButtonStyle.Link); break;
        }

        actionRow.addComponents(button);
      });
      return actionRow;
    });
  }

  await channel.send(payload);
}

/**
 * Create Discord sender adapter from bot instance.
 */
// deno-lint-ignore no-explicit-any
function createDiscordSenderAdapter(bot: any): DiscordSender {
  return {
    async sendMessage(content) {
      const channel = bot.getChannel();
      if (channel) {
        await sendMessageContent(channel, content);
      }
    }
  };
}

/**
 * Create Discord sender adapter that sends to a specific channel (e.g., a thread).
 */
// deno-lint-ignore no-explicit-any
function createChannelSenderAdapter(channel: any): DiscordSender {
  return {
    async sendMessage(content) {
      await sendMessageContent(channel, content);
    }
  };
}

/**
 * Create the AskUserQuestion handler that uses the Discord channel.
 *
 * When Claude calls the AskUserQuestion tool:
 * 1. Builds embeds with option buttons for each question
 * 2. Sends them to the bot's channel (or session thread if available)
 * 3. Waits up to 5 minutes for button clicks
 * 4. Returns answers to the SDK so Claude can continue
 */
// deno-lint-ignore no-explicit-any
function createAskUserDiscordHandler(bot: any, getTargetChannel?: () => any): (input: AskUserQuestionInput) => Promise<Record<string, string>> {
  return async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    const channel = getTargetChannel?.() ?? bot.getChannel();
    if (!channel) {
      throw new Error('Discord channel not available');
    }

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = await import("npm:discord.js@14.14.1");
    const answers: Record<string, string> = {};

    for (let qi = 0; qi < input.questions.length; qi++) {
      const q = input.questions[qi];

      // Build embed
      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle(`❓ Claude needs your input — ${q.header}`)
        .setDescription(q.question)
        .setFooter({ text: q.multiSelect ? 'Select option(s), then click ✅ Confirm — Claude is waiting' : 'Click an option to answer — Claude is waiting' })
        .setTimestamp();

      for (let oi = 0; oi < q.options.length; oi++) {
        embed.addFields({ name: `${oi + 1}. ${q.options[oi].label}`, value: q.options[oi].description, inline: true });
      }

      // Build buttons
      const row = new ActionRowBuilder();
      for (let oi = 0; oi < q.options.length; oi++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ask-user:${qi}:${oi}`)
            .setLabel(q.options[oi].label)
            .setStyle(ButtonStyle.Primary)
        );
      }

      if (q.multiSelect) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ask-user-confirm:${qi}`)
            .setLabel('✅ Confirm')
            .setStyle(ButtonStyle.Success)
        );
      }

      // Send the question message
      const questionMsg = await channel.send({ embeds: [embed], components: [row] });

      // Collect response
      if (q.multiSelect) {
        // Multi-select: collect multiple clicks, then wait for confirm
        const selected: string[] = [];
        const collector = questionMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
        });

        await new Promise<void>((resolve, reject) => {
          // deno-lint-ignore no-explicit-any
          collector.on('collect', async (i: any) => {
            const parsed = parseAskUserButtonId(i.customId);
            if (parsed && parsed.questionIndex === qi) {
              const label = q.options[parsed.optionIndex].label;
              if (!selected.includes(label)) {
                selected.push(label);
              }
              await i.update({
                embeds: [embed.setFooter({ text: `Selected: ${selected.join(', ')} — click ✅ Confirm when done` })],
                components: [row],
              });
            } else if (parseAskUserConfirmId(i.customId)?.questionIndex === qi) {
              answers[q.question] = selected.join(', ');
              collector.stop('confirmed');
              await i.update({
                embeds: [embed.setColor(0x00ff00).setFooter({ text: `✅ Answered: ${selected.join(', ')}` })],
                components: [],
              });
              resolve();
            }
          });

          collector.on('end', (_: unknown, reason: string) => {
            if (reason !== 'confirmed') {
              reject(new Error(`Question "${q.header}" was cancelled`));
            }
          });
        });
      } else {
        // Single-select: wait for one button click
        // deno-lint-ignore no-explicit-any
        const interaction: any = await questionMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
        });

        const parsed = parseAskUserButtonId(interaction.customId);
        if (parsed && parsed.questionIndex === qi) {
          const label = q.options[parsed.optionIndex].label;
          answers[q.question] = label;

          await interaction.update({
            embeds: [embed.setColor(0x00ff00).setFooter({ text: `✅ Answered: ${label}` })],
            components: [],
          });
        } else {
          throw new Error(`Unexpected button ID: ${interaction.customId}`);
        }
      }
    }

    console.log('[AskUserQuestion] Collected answers:', JSON.stringify(answers));
    return answers;
  };
}

/**
 * Create the PermissionRequest handler that uses the Discord channel.
 *
 * When Claude wants to use a tool that isn't pre-approved:
 * 1. Builds an embed showing the tool name and input preview
 * 2. Adds Allow / Deny buttons
 * 3. Sends to the bot's channel
 * 4. Waits for a button click (no timeout — user decides)
 * 5. Returns true (allow) or false (deny)
 */
// deno-lint-ignore no-explicit-any
function createPermissionRequestHandler(bot: any, getTargetChannel?: () => any): PermissionRequestCallback {
  // Simple incrementing nonce to disambiguate concurrent requests
  let nonce = 0;

  return async (toolName: string, toolInput: Record<string, unknown>): Promise<boolean> => {
    const channel = getTargetChannel?.() ?? bot.getChannel();
    if (!channel) {
      console.warn('[PermissionRequest] No channel — auto-denying');
      return false;
    }

    const reqNonce = String(++nonce);
    const embedData = buildPermissionEmbed(toolName, toolInput);

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = await import("npm:discord.js@14.14.1");

    const embed = new EmbedBuilder()
      .setColor(embedData.color)
      .setTitle(embedData.title)
      .setDescription(embedData.description)
      .setFooter({ text: embedData.footer.text })
      .setTimestamp();

    for (const field of embedData.fields) {
      embed.addFields({ name: field.name, value: field.value, inline: field.inline });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-req:${reqNonce}:allow`)
        .setLabel('✅ Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm-req:${reqNonce}:deny`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    // Wait for exactly one button click — no timeout
    // deno-lint-ignore no-explicit-any
    const interaction: any = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
    });

    const parsed = parsePermissionButtonId(interaction.customId);
    const allowed = parsed?.allowed ?? false;

    // Update the embed to reflect the decision
    embed.setColor(allowed ? 0x00ff00 : 0xff4444)
      .setFooter({ text: allowed ? `✅ Allowed by user` : `❌ Denied by user` });

    await interaction.update({
      embeds: [embed],
      components: [], // Remove buttons after decision
    });

    console.log(`[PermissionRequest] Tool "${toolName}" — ${allowed ? 'ALLOWED' : 'DENIED'} by user`);
    return allowed;
  };
}

/**
 * Setup signal handlers for graceful shutdown.
 */
function setupSignalHandlers(ctx: {
  managers: BotManagers;
  allHandlers: AllHandlers;
  getClaudeController: () => AbortController | null;
  claudeSender: ((messages: ClaudeMessage[]) => Promise<void>) | null;
  actualCategoryName: string;
  repoName: string;
  branchName: string;
  cleanupInterval: number;
  // deno-lint-ignore no-explicit-any
  bot: any;
}) {
  const { managers, allHandlers, getClaudeController, claudeSender, actualCategoryName, repoName, branchName, cleanupInterval, bot } = ctx;
  const { crashHandler, healthMonitor } = managers;
  const { shell: shellHandlers, git: gitHandlers } = allHandlers;

  const handleSignal = async (signal: string) => {
    console.log(`\n${signal} signal received. Stopping bot...`);

    try {
      // Stop all processes
      shellHandlers.killAllProcesses();
      gitHandlers.killAllWorktreeBots();

      // Cancel Claude Code session
      const claudeController = getClaudeController();
      if (claudeController) {
        claudeController.abort();
      }

      // Send shutdown message
      if (claudeSender) {
        await claudeSender([{
          type: 'system',
          content: '',
          metadata: {
            subtype: 'shutdown',
            signal,
            categoryName: actualCategoryName,
            repoName,
            branchName
          }
        }]);
      }

      // Cleanup
      healthMonitor.stopAll();
      crashHandler.cleanup();
      cleanupPaginationStates();
      clearInterval(cleanupInterval);

      setTimeout(() => {
        bot.client.destroy();
        Deno.exit(0);
      }, 1000);
    } catch (error) {
      console.error('Error during shutdown:', error);
      Deno.exit(1);
    }
  };

  // Cross-platform signal handling
  const platform = Deno.build.os;

  try {
    Deno.addSignalListener("SIGINT", () => handleSignal("SIGINT"));

    if (platform === "windows") {
      try {
        Deno.addSignalListener("SIGBREAK", () => handleSignal("SIGBREAK"));
      } catch (winError) {
        const message = winError instanceof Error ? winError.message : String(winError);
        console.warn('Could not register SIGBREAK handler:', message);
      }
    } else {
      try {
        Deno.addSignalListener("SIGTERM", () => handleSignal("SIGTERM"));
      } catch (unixError) {
        const message = unixError instanceof Error ? unixError.message : String(unixError);
        console.warn('Could not register SIGTERM handler:', message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Signal handler registration error:', message);
  }
}

// ================================
// .env Auto-Load
// ================================

/**
 * Load environment variables from .env file if it exists.
 * This enables zero-config startup when .env is present.
 */
async function loadEnvFile(): Promise<void> {
  try {
    const envPath = `${Deno.cwd()}/.env`;
    const stat = await Deno.stat(envPath).catch(() => null);

    if (!stat?.isFile) return;

    const content = await Deno.readTextFile(envPath);
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Parse KEY=VALUE format
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Only set if not already defined (env vars take precedence)
      if (!Deno.env.get(key) && key && value) {
        Deno.env.set(key, value);
      }
    }

    console.log('✓ Loaded configuration from .env file');
  } catch (error) {
    // Silently ignore .env loading errors
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Note: Could not load .env file: ${message}`);
  }
}

// ================================
// Main Execution
// ================================

if (import.meta.main) {
  try {
    // Auto-load .env file (if present)
    await loadEnvFile();

    // Get environment variables and command line arguments
    const discordToken = Deno.env.get("DISCORD_TOKEN");
    const applicationId = Deno.env.get("APPLICATION_ID");
    const envCategoryName = Deno.env.get("CATEGORY_NAME");
    const envMentionUserId = Deno.env.get("USER_ID") || Deno.env.get("DEFAULT_MENTION_USER_ID");
    const envWorkDir = Deno.env.get("WORK_DIR");

    if (!discordToken || !applicationId) {
      console.error("╔═══════════════════════════════════════════════════════════╗");
      console.error("║  Error: Missing required configuration                    ║");
      console.error("╠═══════════════════════════════════════════════════════════╣");
      console.error("║  DISCORD_TOKEN and APPLICATION_ID are required.           ║");
      console.error("║                                                           ║");
      console.error("║  Options:                                                 ║");
      console.error("║  1. Create a .env file with these variables               ║");
      console.error("║  2. Set environment variables before running              ║");
      console.error("║  3. Run setup script: ./setup.sh or .\\setup.ps1          ║");
      console.error("╚═══════════════════════════════════════════════════════════╝");
      Deno.exit(1);
    }

    // Parse command line arguments
    const args = parseArgs(Deno.args);
    const categoryName = args.category || envCategoryName;
    const defaultMentionUserId = args.userId || envMentionUserId;
    const workDir = envWorkDir || Deno.cwd();

    // Get Git information
    const gitInfo = await getGitInfo();

    // Create and start bot
    await createClaudeCodeBot({
      discordToken,
      applicationId,
      workDir,
      repoName: gitInfo.repo,
      branchName: gitInfo.branch,
      categoryName,
      defaultMentionUserId,
    });

    console.log("✓ Bot has started. Press Ctrl+C to stop.");
  } catch (error) {
    console.error("Failed to start bot:", error);
    Deno.exit(1);
  }
}
