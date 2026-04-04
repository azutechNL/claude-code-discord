/**
 * Channel → Project binding manager.
 *
 * Allows each Discord channel to be bound to a project directory via the
 * `/bind` slash command. Per-channel bindings override the global WORK_DIR
 * so `/claude` operates on the right codebase for each channel.
 *
 * Bindings are persisted to `.bot-data/channel-bindings.json` so they
 * survive container restarts.
 *
 * @module core/channel-bindings
 */

import * as path from "https://deno.land/std@0.208.0/path/mod.ts";
import type {
  PersistenceManager,
  ChannelBindingsData,
  ProjectConfig,
} from "../util/persistence.ts";

export type { ProjectConfig };

/**
 * Result of validating a candidate bind path.
 */
export interface BindValidation {
  ok: boolean;
  /** Absolute, normalized path — only set when ok=true. */
  resolvedPath?: string;
  /** Human-readable error when ok=false. */
  error?: string;
}

/**
 * Validate a user-supplied folder path:
 *   - must be non-empty
 *   - resolves to an absolute path
 *   - must exist on disk
 *   - must be a directory
 *
 * The caller is trusted to pass this path — we only guard against
 * typos, not adversarial inputs. (Trust model: YOLO, full access.)
 */
export async function validateBindPath(rawPath: string): Promise<BindValidation> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "Path is empty" };
  }

  // Expand `~` to the caller's home dir.
  let resolved = trimmed;
  if (resolved.startsWith("~/") || resolved === "~") {
    const home = Deno.env.get("HOME") ?? "/root";
    resolved = resolved === "~" ? home : path.join(home, resolved.slice(2));
  }

  // Normalize relative paths against CWD (unusual but we support it).
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(resolved);
  } else {
    resolved = path.normalize(resolved);
  }

  try {
    const stat = await Deno.stat(resolved);
    if (!stat.isDirectory) {
      return { ok: false, error: `Path is not a directory: ${resolved}` };
    }
    return { ok: true, resolvedPath: resolved };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { ok: false, error: `Path does not exist: ${resolved}` };
    }
    return {
      ok: false,
      error: `Cannot access path ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Manages the per-channel project-directory bindings.
 */
export class ChannelBindingManager {
  private bindings = new Map<string, ProjectConfig>();
  private persister: PersistenceManager<ChannelBindingsData>;

  constructor(persister: PersistenceManager<ChannelBindingsData>) {
    this.persister = persister;
  }

  /**
   * Hydrate the in-memory map from the persistence layer.
   * Call once during bot startup.
   */
  async load(): Promise<number> {
    const data = await this.persister.load({});
    for (const [channelId, cfg] of Object.entries(data)) {
      this.bindings.set(channelId, cfg);
    }
    console.log(
      `[ChannelBindings] Loaded ${this.bindings.size} channel binding(s)`,
    );
    return this.bindings.size;
  }

  /** Returns the ProjectConfig bound to `channelId`, or undefined. */
  get(channelId: string): ProjectConfig | undefined {
    return this.bindings.get(channelId);
  }

  /** Returns true if the channel has a binding. */
  has(channelId: string): boolean {
    return this.bindings.has(channelId);
  }

  /** Convenience: returns the bound workDir, or undefined. */
  getWorkDir(channelId: string): string | undefined {
    return this.bindings.get(channelId)?.workDir;
  }

  /** Returns a snapshot of all current bindings. */
  getAll(): Map<string, ProjectConfig> {
    return new Map(this.bindings);
  }

  /** Returns the current count of bindings. */
  size(): number {
    return this.bindings.size;
  }

  /**
   * Bind a channel to a project directory. Persists to disk.
   */
  async set(channelId: string, config: ProjectConfig): Promise<void> {
    this.bindings.set(channelId, config);
    await this.save();
  }

  /**
   * Remove a channel binding. Persists to disk.
   * Returns true if a binding was removed, false if none existed.
   */
  async delete(channelId: string): Promise<boolean> {
    const existed = this.bindings.delete(channelId);
    if (existed) await this.save();
    return existed;
  }

  /**
   * Flush the current in-memory map to disk.
   * @internal
   */
  private async save(): Promise<void> {
    const snapshot: ChannelBindingsData = {};
    for (const [cid, cfg] of this.bindings) snapshot[cid] = cfg;
    await this.persister.save(snapshot);
  }
}
