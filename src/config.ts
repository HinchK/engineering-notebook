import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export type RemoteSource = {
  name: string;
  host: string;
  path: string;
  enabled: boolean;
};

export type Config = {
  sources: string[];
  exclude: string[];
  db_path: string;
  port: number;
  day_start_hour: number;
  summary_instructions: string;
  remote_sources: RemoteSource[];
  auto_sync_interval: number;
};

export function defaultConfig(): Config {
  const configDir = join(homedir(), ".config", "engineering-notebook");
  return {
    sources: [
      "~/.claude/projects",
      "~/.codex/sessions",
      "~/.gemini/antigravity-cli/conversations",
    ],
    exclude: ["-private-tmp*", "*-skill-test-*"],
    db_path: join(configDir, "notebook.db"),
    port: 3000,
    day_start_hour: 5,
    summary_instructions: "",
    remote_sources: [],
    auto_sync_interval: 60,
  };
}

export function resolveConfigPath(): string {
  return join(homedir(), ".config", "engineering-notebook", "config.json");
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolveConfigPath();
  if (!existsSync(configPath)) {
    return defaultConfig();
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  const config = { ...defaultConfig(), ...parsed };

  // Migrate older default source lists forward to the current default set
  // (adds Codex, then Antigravity). Only fires when the user is still on a
  // recognized older default — a customized list is left untouched.
  if (Array.isArray(parsed.sources)) {
    const oldDefaults = [
      ["~/.claude/projects"],
      ["~/.claude/projects", "~/.codex/sessions"],
    ];
    const isOldDefault = oldDefaults.some(
      (d) =>
        d.length === parsed.sources!.length &&
        d.every((s, i) => s === parsed.sources![i])
    );
    if (isOldDefault) {
      config.sources = defaultConfig().sources;
    }
  }

  return config;
}

export function saveConfig(path: string, config: Config): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** Expand ~ to homedir in a path */
export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
