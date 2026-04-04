/**
 * Slash commands for managing per-channel project bindings.
 *
 * - `/bind <folder> [label]` — associate current channel with a project directory
 * - `/unbind` — remove the current channel's binding
 * - `/bindings` — list all current channel→project bindings
 *
 * @module core/bind-commands
 */

import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import type { CommandHandlers, InteractionContext } from "../discord/index.ts";
import type { ChannelBindingManager } from "./channel-bindings.ts";
import { validateBindPath } from "./channel-bindings.ts";
import { createFormattedEmbed } from "../discord/index.ts";

// ================================
// Slash command definitions
// ================================

export const bindCommands = [
  new SlashCommandBuilder()
    .setName("bind")
    .setDescription("Bind this channel to a project directory for /claude")
    .addStringOption((opt) =>
      opt
        .setName("folder")
        .setDescription("Absolute path to the project directory (e.g. /workspaces/myrepo)")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("label")
        .setDescription("Optional human-readable label shown in /bindings")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("unbind")
    .setDescription("Remove this channel's project binding"),

  new SlashCommandBuilder()
    .setName("bindings")
    .setDescription("List all channel→project bindings"),
];

// ================================
// Handlers
// ================================

/**
 * Dependencies for bind command handlers.
 */
export interface BindHandlerDeps {
  channelBindings: ChannelBindingManager;
  /** Global fallback WORK_DIR shown in /bindings for unbound channels. */
  globalWorkDir: string;
}

/**
 * Create the bind command handlers map.
 */
export function createBindCommandHandlers(
  deps: BindHandlerDeps,
): CommandHandlers {
  const { channelBindings, globalWorkDir } = deps;
  const handlers: CommandHandlers = new Map();

  handlers.set("bind", {
    execute: async (ctx: InteractionContext) => {
      await ctx.deferReply();

      const folder = ctx.getString("folder", true)!;
      const label = ctx.getString("label") ?? undefined;
      const channelId = ctx.getChannelId();
      const userId = ctx.getUserId();

      const validation = await validateBindPath(folder);
      if (!validation.ok) {
        const { embed } = createFormattedEmbed(
          "❌ Bind failed",
          validation.error ?? "Invalid path",
          0xff0000,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      await channelBindings.set(channelId, {
        workDir: validation.resolvedPath!,
        boundAt: new Date().toISOString(),
        boundBy: userId,
        label,
      });

      const { embed } = createFormattedEmbed(
        "✅ Channel bound",
        [
          `**Working directory:** \`${validation.resolvedPath}\``,
          label ? `**Label:** ${label}` : null,
          "",
          "`/claude` in this channel will now operate on this directory.",
        ]
          .filter(Boolean)
          .join("\n"),
        0x00ff00,
      );
      await ctx.editReply({ embeds: [embed] });
    },
  });

  handlers.set("unbind", {
    execute: async (ctx: InteractionContext) => {
      await ctx.deferReply();
      const channelId = ctx.getChannelId();
      const existing = channelBindings.get(channelId);
      const removed = await channelBindings.delete(channelId);

      if (!removed) {
        const { embed } = createFormattedEmbed(
          "ℹ️ No binding",
          "This channel has no project binding.",
          0x808080,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      const { embed } = createFormattedEmbed(
        "✅ Channel unbound",
        [
          `Removed binding for \`${existing?.workDir}\`.`,
          `\`/claude\` in this channel will now use the global WORK_DIR: \`${globalWorkDir}\``,
        ].join("\n"),
        0x00ff00,
      );
      await ctx.editReply({ embeds: [embed] });
    },
  });

  handlers.set("bindings", {
    execute: async (ctx: InteractionContext) => {
      await ctx.deferReply();
      const all = channelBindings.getAll();

      if (all.size === 0) {
        const { embed } = createFormattedEmbed(
          "📂 Channel bindings",
          `No channels bound yet. Use \`/bind <folder>\` in any channel to create one.\n\nGlobal WORK_DIR: \`${globalWorkDir}\``,
          0x5865f2,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      const lines: string[] = [];
      for (const [cid, cfg] of all) {
        const who = cfg.label ? `**${cfg.label}** · ` : "";
        lines.push(`<#${cid}> → ${who}\`${cfg.workDir}\``);
      }
      lines.push("");
      lines.push(`Global WORK_DIR (fallback): \`${globalWorkDir}\``);

      const { embed } = createFormattedEmbed(
        "📂 Channel bindings",
        lines.join("\n"),
        0x5865f2,
      );
      await ctx.editReply({ embeds: [embed] });
    },
  });

  return handlers;
}
