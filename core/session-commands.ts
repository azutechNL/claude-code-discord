/**
 * Slash commands for inspecting + resetting Claude sessions per channel.
 *
 *   /session reset   — drop this channel's session ID (next message starts fresh)
 *   /session info    — show this channel's session ID + persona + workDir
 *
 * Needed because resumed Claude sessions lock in their original MCP
 * servers + system prompt. When a user swaps a persona (or enables
 * openclaw) on a channel that already has an active session, the new
 * tools aren't available until the session is reset.
 *
 * @module core/session-commands
 */

import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import type { CommandHandlers, InteractionContext } from "../discord/index.ts";
import type { ChannelBindingManager } from "./channel-bindings.ts";
import type { PersonaManager } from "./persona.ts";
import { createFormattedEmbed } from "../discord/index.ts";

// ================================
// Slash command definitions
// ================================

export const sessionCommands = [
  new SlashCommandBuilder()
    .setName("session")
    .setDescription("Inspect or reset this channel's Claude session")
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Drop this channel's session ID — next message starts fresh")
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("Show this channel's current session ID, persona, and workDir")
    ),
];

// ================================
// Handlers
// ================================

export interface SessionHandlerDeps {
  channelBindings: ChannelBindingManager;
  personaManager: PersonaManager;
  /** Session ops from allHandlers.claude — reused to read/write the map. */
  getSessionForChannel: (channelId: string) => string | undefined;
  setSessionForChannel: (channelId: string, sessionId: string | undefined) => void;
  /** Global fallback WORK_DIR shown in /session info for unbound channels. */
  globalWorkDir: string;
}

export function createSessionCommandHandlers(
  deps: SessionHandlerDeps,
): CommandHandlers {
  const {
    channelBindings,
    personaManager,
    getSessionForChannel,
    setSessionForChannel,
    globalWorkDir,
  } = deps;
  const handlers: CommandHandlers = new Map();

  handlers.set("session", {
    execute: async (ctx: InteractionContext) => {
      await ctx.deferReply();
      const subcommand = ctx.getSubcommand(false);
      const channelId = ctx.getChannelId();

      if (subcommand === "reset") {
        const existing = getSessionForChannel(channelId);
        if (!existing) {
          const { embed } = createFormattedEmbed(
            "ℹ️ No session",
            "This channel has no active Claude session.",
            0x808080,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }
        setSessionForChannel(channelId, undefined);
        const { embed } = createFormattedEmbed(
          "✅ Session reset",
          [
            `Dropped session \`${existing.slice(0, 8)}…\` for this channel.`,
            `The next message will start a fresh session with current persona + tools.`,
          ].join("\n"),
          0x00ff00,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      if (subcommand === "info") {
        const sessionId = getSessionForChannel(channelId);
        const binding = channelBindings.get(channelId);
        const persona = binding?.personaName
          ? personaManager.get(binding.personaName)
          : undefined;
        const workDir = binding?.workDir ?? globalWorkDir;

        const lines: string[] = [];
        lines.push(
          sessionId
            ? `**Session:** \`${sessionId}\``
            : `**Session:** _none (next message starts fresh)_`,
        );
        lines.push(`**Working directory:** \`${workDir}\``);
        if (persona) {
          lines.push(`**Persona:** ${persona.name} — ${persona.description}`);
        } else if (binding?.personaName) {
          lines.push(`**Persona:** \`${binding.personaName}\` _(not loaded — run /persona reload)_`);
        } else {
          lines.push(`**Persona:** _none_`);
        }
        if (binding?.label) {
          lines.push(`**Binding label:** ${binding.label}`);
        }

        const { embed } = createFormattedEmbed(
          "🧭 Channel session",
          lines.join("\n"),
          0x5865f2,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      const { embed } = createFormattedEmbed(
        "❓ Unknown subcommand",
        "Use `/session reset` or `/session info`.",
        0x808080,
      );
      await ctx.editReply({ embeds: [embed] });
    },
  });

  return handlers;
}
