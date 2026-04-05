/**
 * Slash commands for attaching / inspecting personas on channels.
 *
 *   /persona load <name>    — attach a preset to the current channel
 *   /persona clear          — detach the current channel's persona
 *   /persona show           — describe the active persona on this channel
 *   /persona list           — list all loaded preset names + descriptions
 *   /persona reload         — re-scan personas/*.json (hot-swap)
 *
 * Personas are resolved at query time, so changes take effect on the
 * next /claude (no bot restart needed).
 *
 * @module core/persona-commands
 */

import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import type { CommandHandlers, InteractionContext } from "../discord/index.ts";
import type { PersonaManager } from "./persona.ts";
import type { ChannelBindingManager } from "./channel-bindings.ts";
import { createFormattedEmbed } from "../discord/index.ts";

// ================================
// Slash command definitions
// ================================

export const personaCommands = [
  new SlashCommandBuilder()
    .setName("persona")
    .setDescription("Manage the persona attached to this channel")
    .addSubcommand((sub) =>
      sub
        .setName("load")
        .setDescription("Attach a persona preset to the current channel")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Name of the persona preset (without .json)")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("Detach the current channel's persona")
    )
    .addSubcommand((sub) =>
      sub.setName("show").setDescription("Show the active persona on this channel")
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all loaded persona presets")
    )
    .addSubcommand((sub) =>
      sub.setName("reload").setDescription("Re-scan personas/*.json (hot-swap)")
    ),
];

// ================================
// Handlers
// ================================

export interface PersonaHandlerDeps {
  personaManager: PersonaManager;
  channelBindings: ChannelBindingManager;
  /** Global fallback used when auto-creating a binding via /persona load. */
  globalWorkDir: string;
}

export function createPersonaCommandHandlers(
  deps: PersonaHandlerDeps,
): CommandHandlers {
  const { personaManager, channelBindings, globalWorkDir } = deps;
  const handlers: CommandHandlers = new Map();

  handlers.set("persona", {
    execute: async (ctx: InteractionContext) => {
      await ctx.deferReply();
      const subcommand = ctx.getSubcommand(false);
      const channelId = ctx.getChannelId();
      const userId = ctx.getUserId();

      if (subcommand === "load") {
        const name = ctx.getString("name", true)!;
        if (!personaManager.has(name)) {
          const available = personaManager.list().map((p) => p.name).join(", ") || "(none)";
          const { embed } = createFormattedEmbed(
            "❌ Unknown persona",
            [
              `No preset named \`${name}\`.`,
              `Available: ${available}`,
              `Use \`/persona list\` to see details.`,
            ].join("\n"),
            0xff0000,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }

        const existing = channelBindings.get(channelId);
        const nextBinding = existing
          ? { ...existing, personaName: name }
          : {
              workDir: globalWorkDir,
              boundAt: new Date().toISOString(),
              boundBy: userId,
              label: `auto-bound (persona: ${name})`,
              personaName: name,
            };
        await channelBindings.set(channelId, nextBinding);

        const persona = personaManager.get(name)!;
        const { embed } = createFormattedEmbed(
          "✅ Persona attached",
          [
            `**Name:** ${persona.name}`,
            `**Description:** ${persona.description}`,
            `**Working directory:** \`${nextBinding.workDir}\``,
            persona.model ? `**Model:** ${persona.model}` : null,
          ].filter(Boolean).join("\n"),
          0x00ff00,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      if (subcommand === "clear") {
        const existing = channelBindings.get(channelId);
        if (!existing || !existing.personaName) {
          const { embed } = createFormattedEmbed(
            "ℹ️ No persona",
            "This channel has no persona attached.",
            0x808080,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }
        const prev = existing.personaName;
        const next = { ...existing };
        delete next.personaName;
        await channelBindings.set(channelId, next);
        const { embed } = createFormattedEmbed(
          "✅ Persona detached",
          `Removed persona \`${prev}\`. Channel reverts to bot defaults.`,
          0x00ff00,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      if (subcommand === "show") {
        const existing = channelBindings.get(channelId);
        const personaName = existing?.personaName;
        if (!personaName) {
          const { embed } = createFormattedEmbed(
            "ℹ️ No persona",
            "This channel has no persona attached. Use `/persona load <name>`.",
            0x808080,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }
        const persona = personaManager.get(personaName);
        if (!persona) {
          const { embed } = createFormattedEmbed(
            "⚠️ Persona missing",
            `Channel references \`${personaName}\` but it's not loaded. Did you delete the preset file? Try \`/persona reload\`.`,
            0xffaa00,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }
        const tools =
          (persona.allowedTools?.length ? `allowed: ${persona.allowedTools.join(", ")}` : null) ??
          null;
        const mcp = persona.mcpServers ? Object.keys(persona.mcpServers).join(", ") : null;
        const agents = persona.agents ? Object.keys(persona.agents).join(", ") : null;
        const { embed } = createFormattedEmbed(
          `🎭 Persona: ${persona.name}`,
          [
            persona.description,
            "",
            persona.model ? `**Model:** ${persona.model}` : null,
            tools ? `**Tools:** ${tools}` : null,
            persona.disallowedTools?.length
              ? `**Denied tools:** ${persona.disallowedTools.join(", ")}`
              : null,
            mcp ? `**MCP servers:** ${mcp}` : null,
            agents ? `**Subagents:** ${agents}` : null,
            persona.appendSystemPrompt
              ? `\n**Appended prompt (first 300):**\n\`\`\`\n${persona.appendSystemPrompt.slice(0, 300)}${persona.appendSystemPrompt.length > 300 ? "…" : ""}\n\`\`\``
              : null,
          ].filter(Boolean).join("\n"),
          0x5865f2,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      if (subcommand === "list") {
        const all = personaManager.list();
        if (all.length === 0) {
          const { embed } = createFormattedEmbed(
            "📂 Personas",
            `No presets loaded. Add JSON files to \`${personaManager.getDir()}\` and run \`/persona reload\`.`,
            0x808080,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }
        const lines = all.map((p) => {
          const bits: string[] = [`**${p.name}**`, p.description];
          if (p.model) bits.push(`model: ${p.model}`);
          return `• ${bits.join(" — ")}`;
        });
        const { embed } = createFormattedEmbed(
          `📂 Personas (${all.length})`,
          lines.join("\n"),
          0x5865f2,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      if (subcommand === "reload") {
        const count = await personaManager.reload();
        const { embed } = createFormattedEmbed(
          "🔁 Personas reloaded",
          `Reloaded ${count} preset(s) from \`${personaManager.getDir()}\`.`,
          0x00ff00,
        );
        await ctx.editReply({ embeds: [embed] });
        return;
      }

      // Fallback
      const { embed } = createFormattedEmbed(
        "❓ Unknown subcommand",
        "Use `/persona load|clear|show|list|reload`.",
        0x808080,
      );
      await ctx.editReply({ embeds: [embed] });
    },
  });

  return handlers;
}
