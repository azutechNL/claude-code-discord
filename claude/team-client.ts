/**
 * Team registry client — structured, version-controlled source of truth
 * for who's on the project (humans + agent personas), their skills,
 * and their identity IDs (Jira accountId, Discord user ID, etc).
 *
 * Pairs with Honcho: team.json holds deterministic facts (ID lookups,
 * role, skills), Honcho holds fuzzy context (preferences, past decisions,
 * velocity patterns).
 *
 * File layout on disk:
 *
 * ```json
 * {
 *   "description": "Team registry for project-manager persona.",
 *   "members": [
 *     {
 *       "id": "karim",
 *       "kind": "human",
 *       "display_name": "Karim Azzouz",
 *       "jira_account_id": "712020:c2ad...",
 *       "discord_user_id": "",
 *       "persona": null,
 *       "skills": ["product", "review"],
 *       "notes": "..."
 *     }
 *   ]
 * }
 * ```
 *
 * Writes are in-place. For small registries (<5KB) and our single-writer
 * model (the project-manager persona), a single `Deno.writeTextFile` call
 * is effectively atomic at the syscall level. We can't use a temp-file
 * rename strategy because team.json is bind-mounted into the container
 * and Docker bind mounts reject `rename()` with EBUSY.
 *
 * @module claude/team-client
 */

export type TeamMemberKind = "human" | "agent";

export interface TeamMember {
  id: string;
  kind: TeamMemberKind;
  display_name: string;
  /** Short nickname/handle, e.g. 'Mo' for 'Mohamed Chilh'. */
  alias?: string;
  jira_account_id?: string;
  discord_user_id?: string;
  persona?: string;
  skills: string[];
  notes?: string;
}

export interface TeamRegistry {
  description?: string;
  members: TeamMember[];
}

export interface TeamClientConfig {
  filePath: string;
}

export function getTeamConfig(): TeamClientConfig | undefined {
  const filePath = Deno.env.get("TEAM_JSON_PATH") ?? "/app/team.json";
  try {
    const info = Deno.statSync(filePath);
    if (!info.isFile) return undefined;
  } catch {
    return undefined;
  }
  return { filePath };
}

function normalizeMember(input: Partial<TeamMember>): TeamMember {
  if (!input.id || !input.kind || !input.display_name) {
    throw new Error("team member requires id, kind, and display_name");
  }
  if (input.kind !== "human" && input.kind !== "agent") {
    throw new Error(`team member kind must be 'human' or 'agent', got '${input.kind}'`);
  }
  return {
    id: input.id,
    kind: input.kind,
    display_name: input.display_name,
    ...(input.alias !== undefined ? { alias: input.alias } : {}),
    ...(input.jira_account_id !== undefined ? { jira_account_id: input.jira_account_id } : {}),
    ...(input.discord_user_id !== undefined ? { discord_user_id: input.discord_user_id } : {}),
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    skills: Array.isArray(input.skills) ? input.skills.filter((s) => typeof s === "string") : [],
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
}

export class TeamClient {
  constructor(public readonly config: TeamClientConfig) {}

  async load(): Promise<TeamRegistry> {
    const raw = await Deno.readTextFile(this.config.filePath);
    const parsed = JSON.parse(raw) as TeamRegistry;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.members)) {
      throw new Error("team.json: expected { members: [...] }");
    }
    return parsed;
  }

  async list(): Promise<TeamMember[]> {
    const reg = await this.load();
    return reg.members;
  }

  async findById(id: string): Promise<TeamMember | undefined> {
    const members = await this.list();
    return members.find((m) => m.id === id);
  }

  async findByDiscordId(discordUserId: string): Promise<TeamMember | undefined> {
    const members = await this.list();
    return members.find((m) => m.discord_user_id === discordUserId);
  }

  async findByJiraAccountId(jiraAccountId: string): Promise<TeamMember | undefined> {
    const members = await this.list();
    return members.find((m) => m.jira_account_id === jiraAccountId);
  }

  /** Case-insensitive lookup by id, alias, or display_name substring. */
  async findByName(needle: string): Promise<TeamMember | undefined> {
    const members = await this.list();
    const n = needle.toLowerCase().trim();
    return members.find((m) =>
      m.id.toLowerCase() === n ||
      (m.alias ?? "").toLowerCase() === n ||
      m.display_name.toLowerCase().includes(n)
    );
  }

  /**
   * Merge a member into the registry. If a member with the same `id`
   * exists, its fields are merged (new values replace old, skills are
   * unioned). Otherwise a new member is appended.
   *
   * Writes atomically via a temp-file rename so concurrent readers
   * can't observe a half-written registry.
   */
  async upsertMember(input: Partial<TeamMember>): Promise<{
    member: TeamMember;
    created: boolean;
  }> {
    const reg = await this.load();
    const normalized = normalizeMember(input);
    const existingIdx = reg.members.findIndex((m) => m.id === normalized.id);
    let created = false;
    let finalMember: TeamMember;
    if (existingIdx === -1) {
      reg.members.push(normalized);
      created = true;
      finalMember = normalized;
    } else {
      const existing = reg.members[existingIdx];
      const mergedSkills = Array.from(
        new Set([...(existing.skills ?? []), ...normalized.skills]),
      );
      finalMember = {
        ...existing,
        ...normalized,
        skills: mergedSkills,
      };
      reg.members[existingIdx] = finalMember;
    }
    await this.write(reg);
    return { member: finalMember, created };
  }

  private async write(reg: TeamRegistry): Promise<void> {
    const text = JSON.stringify(reg, null, 2) + "\n";
    await Deno.writeTextFile(this.config.filePath, text);
  }
}

export function buildTeamClient(): TeamClient | undefined {
  const cfg = getTeamConfig();
  if (!cfg) return undefined;
  return new TeamClient(cfg);
}
