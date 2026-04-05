// Discord module types
import type { TextChannel, ThreadChannel } from "npm:discord.js@14.14.1";
import type { BotSettings } from "../types/shared.ts";

export interface EmbedData {
  color?: number;
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: boolean;
}

export interface ComponentData {
  type: 'button';
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger' | 'link';
  disabled?: boolean;
}

export interface FileAttachment {
  /** File path or URL */
  path: string;
  /** Optional display name */
  name?: string;
  /** Optional description */
  description?: string;
}

export interface MessageContent {
  content?: string;
  embeds?: EmbedData[];
  components?: Array<{ type: 'actionRow'; components: ComponentData[] }>;
  /** File attachments to include */
  files?: FileAttachment[];
}

export interface InteractionContext {
  deferReply(): Promise<void>;
  editReply(content: MessageContent): Promise<void>;
  followUp(content: MessageContent & { ephemeral?: boolean }): Promise<void>;
  reply(content: MessageContent & { ephemeral?: boolean }): Promise<void>;
  update(content: MessageContent): Promise<void>;
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getBoolean(name: string, required?: boolean): boolean | null;
  /** Returns the set of role IDs the invoking member has */
  getMemberRoleIds(): Set<string>;
  /** Returns the invoking member's user ID */
  getUserId(): string;
  /** Returns the channel or thread ID the interaction was sent in */
  getChannelId(): string;
}

export interface BotConfig {
  discordToken: string;
  applicationId: string;
  workDir: string;
  repoName: string;
  branchName: string;
  categoryName?: string;
  defaultMentionUserId?: string;
}

// Abstract command handler interface
export interface CommandHandler {
  // Execute the command
  execute(ctx: InteractionContext): Promise<void> | void;
  // Optional: Handle button interactions for this command
  handleButton?(ctx: InteractionContext, customId: string): Promise<void> | void;
}

// Map of command name to handler
export type CommandHandlers = Map<string, CommandHandler>;

// Button handler type
export type ButtonHandler = (ctx: InteractionContext) => Promise<void> | void;

// Button handler registry
export type ButtonHandlers = Map<string, ButtonHandler>;

// Interfaces for dependency injection

export interface SlashCommand {
  name: string;
  description: string;
  // deno-lint-ignore no-explicit-any
  options?: any[];
  // deno-lint-ignore no-explicit-any
  toJSON(): any;
}

export interface MonitorConfig {
  /** Discord channel ID to watch for messages */
  channelId: string;
  /** Bot/webhook user IDs whose messages trigger auto-response */
  botIds: string[];
  /** Callback invoked with batched alert content and the thread to stream output to */
  onAlertMessage: (content: string, thread: TextChannel) => Promise<void>;
}

/**
 * Tracks the mapping between a Claude session and its dedicated Discord thread.
 */
export interface SessionThread {
  /** Claude session ID */
  sessionId: string;
  /** Discord thread ID */
  threadId: string;
  /** Thread name (derived from the first prompt) */
  threadName: string;
  /** When the session thread was created */
  createdAt: Date;
  /** When the last message was sent in this thread */
  lastActivity: Date;
  /** Number of messages sent in this thread */
  messageCount: number;
}

export interface BotDependencies {
  commands: SlashCommand[];
  cleanSessionId?: (sessionId: string) => string;
  /** Optional bot settings for mention functionality */
  botSettings?: BotSettings;
  /** Callback to actually continue a Claude session from a button click */
  onContinueSession?: (ctx: InteractionContext) => Promise<void>;
  /** Optional channel monitoring config for auto-responding to messages */
  monitorConfig?: MonitorConfig;
  /** Static list of Discord channel IDs (including forum channels) in which
   *  the bot accepts slash commands and button interactions. Loaded from
   *  the ALLOWED_CHANNEL_IDS env var. Threads whose parent is in this list
   *  are also accepted. */
  allowedChannelIds?: Set<string>;
  /** Dynamic callback: true if the channel ID has a /bind project binding.
   *  Bound channels are auto-allowed in addition to allowedChannelIds. */
  isChannelBound?: (channelId: string) => boolean;
  /** Invoked when a new thread is created in a forum channel the bot
   *  manages (via allowedChannelIds or /bind). Typically spawns a fresh
   *  Claude session scoped to the forum's project binding, with the
   *  forum post's body as the initial prompt. */
  onForumThreadCreated?: (thread: ThreadChannel) => Promise<void>;
  /** Invoked when a plain (non-slash-command) message arrives in a managed
   *  channel/thread. Enables "ambient messaging" — users can continue a
   *  Claude session without prefixing every message with /claude.
   *  The bot filters out its own messages, bot/webhook messages, and
   *  messages from the bot's auto-created main channel before invoking. */
  // deno-lint-ignore no-explicit-any
  onChannelMessage?: (message: any) => Promise<void>;
}
