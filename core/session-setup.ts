/**
 * Interactive session setup wizard.
 *
 * When a user sends their first message in a channel that has no binding
 * (no workDir, no persona), this wizard fires instead of running a Claude
 * query. It presents two dropdown menus:
 *   1. Which workspace/project folder?
 *   2. Which persona?
 *
 * After the user picks both, the bot auto-binds + loads the persona,
 * then tells the user to resend their message.
 *
 * @module core/session-setup
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ComponentType,
} from "npm:discord.js@14.14.1";

import type { ChannelBindingManager } from "./channel-bindings.ts";
import type { PersonaManager } from "./persona.ts";

export interface SetupWizardDeps {
  channelBindings: ChannelBindingManager;
  personaManager: PersonaManager;
  /** Base path for project dirs inside the container (e.g. /workspaces/projects). */
  workspacesRoot: string;
  /** Global fallback WORK_DIR. */
  globalWorkDir: string;
  /** Called after the wizard binds + loads persona — resets any stale session. */
  onSetupComplete?: (channelId: string) => void;
}

/**
 * Discover available project folders under the workspaces root.
 */
async function discoverWorkspaces(root: string): Promise<string[]> {
  const dirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        dirs.push(entry.name);
      }
    }
  } catch {
    // root doesn't exist or isn't readable
  }
  return dirs.sort();
}

/**
 * Send the setup wizard embed into a Discord channel. Returns true if
 * the wizard was shown (channel needed setup), false if the channel is
 * already configured and the caller should proceed normally.
 */
export async function runSetupWizard(
  deps: SetupWizardDeps,
  // deno-lint-ignore no-explicit-any
  channel: any,
  channelId: string,
  userId: string,
): Promise<boolean> {
  // Already bound? Skip the wizard.
  if (deps.channelBindings.has(channelId)) return false;

  const workspaces = await discoverWorkspaces(deps.workspacesRoot);
  const personas = deps.personaManager.list();

  if (workspaces.length === 0 && personas.length === 0) {
    // Nothing to configure — let the query proceed with global defaults.
    return false;
  }

  // Build workspace select menu
  const workspaceOptions = workspaces.slice(0, 25).map((name) => ({
    label: name,
    value: name,
    description: `${deps.workspacesRoot}/${name}`,
  }));

  // Add a "global (all projects)" option at the top
  workspaceOptions.unshift({
    label: "All projects (workspace root)",
    value: "__global__",
    description: deps.globalWorkDir,
  });

  const workspaceSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup:workspace")
      .setPlaceholder("Select a project workspace…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(workspaceOptions),
  );

  // Build persona select menu
  const personaOptions = personas.slice(0, 25).map((p) => ({
    label: p.name,
    value: p.name,
    description: p.description.slice(0, 100),
  }));

  // Add a "none" option
  personaOptions.unshift({
    label: "No persona (defaults)",
    value: "__none__",
    description: "Use Claude Code defaults — no custom system prompt or tools.",
  });

  const personaSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup:persona")
      .setPlaceholder("Select a persona…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(personaOptions),
  );

  const embed = new EmbedBuilder()
    .setColor(0xff9900)
    .setTitle("🔧 Channel setup required")
    .setDescription(
      [
        "This channel isn't configured yet. Pick a **workspace** and a **persona** below, then resend your message.",
        "",
        "**Workspace** = which project folder Claude operates in.",
        "**Persona** = how Claude behaves (system prompt, model, tools, subagents).",
        "",
        "_Selections auto-apply `/bind` + `/persona load`. You can change later with those commands._",
      ].join("\n"),
    )
    .setTimestamp();

  const setupMsg = await channel.send({
    embeds: [embed],
    components: [workspaceSelect, personaSelect],
  });

  // State for collecting both selections
  let selectedWorkspace: string | null = null;
  let selectedPersona: string | null = null;

  // Await interactions (5 minutes timeout)
  const collector = setupMsg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i: { user: { id: string } }) => i.user.id === userId,
    time: 300_000,
  });

  return new Promise<boolean>((resolve) => {
    const tryFinalize = async () => {
      if (selectedWorkspace === null || selectedPersona === null) return;

      // Apply binding
      const workDir =
        selectedWorkspace === "__global__"
          ? deps.globalWorkDir
          : `${deps.workspacesRoot}/${selectedWorkspace}`;

      const binding: {
        workDir: string;
        boundAt: string;
        boundBy: string;
        label?: string;
        personaName?: string;
      } = {
        workDir,
        boundAt: new Date().toISOString(),
        boundBy: userId,
        label: selectedWorkspace === "__global__" ? "all projects" : selectedWorkspace,
      };

      if (selectedPersona !== "__none__") {
        binding.personaName = selectedPersona;
      }

      await deps.channelBindings.set(channelId, binding);
      deps.onSetupComplete?.(channelId);

      // Confirm
      const persona = selectedPersona !== "__none__"
        ? deps.personaManager.get(selectedPersona)
        : null;

      const confirmEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("✅ Channel ready")
        .setDescription(
          [
            `**Workspace:** \`${workDir}\``,
            persona ? `**Persona:** ${persona.name} — ${persona.description}` : "**Persona:** defaults",
            "",
            "Send your message now — I'm ready to work.",
          ].join("\n"),
        )
        .setTimestamp();

      try {
        await setupMsg.edit({ embeds: [confirmEmbed], components: [] });
      } catch {
        await channel.send({ embeds: [confirmEmbed] });
      }

      collector.stop();
      resolve(true);
    };

    // deno-lint-ignore no-explicit-any
    collector.on("collect", async (interaction: any) => {
      if (interaction.customId === "setup:workspace") {
        selectedWorkspace = interaction.values[0];
        await interaction.deferUpdate();
      } else if (interaction.customId === "setup:persona") {
        selectedPersona = interaction.values[0];
        await interaction.deferUpdate();
      }
      await tryFinalize();
    });

    collector.on("end", (_collected: unknown, reason: string) => {
      if (reason === "time") {
        setupMsg
          .edit({
            embeds: [
              new EmbedBuilder()
                .setColor(0x808080)
                .setTitle("⏰ Setup timed out")
                .setDescription("No selections made in 5 minutes. Send a new message to try again.")
                .setTimestamp(),
            ],
            components: [],
          })
          .catch(() => {});
        resolve(true); // consumed the message — caller should not proceed
      }
    });
  });
}
