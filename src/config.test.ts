import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, saveConfig, defaultConfig, expandPath, type Config } from "./config";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmpdir } from "os";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("defaultConfig has expected shape", () => {
    const config = defaultConfig();
    expect(config.sources).toEqual([
      "~/.claude/projects",
      "~/.codex/sessions",
      "~/.gemini/antigravity-cli/conversations",
    ]);
    expect(config.exclude).toContain("-private-tmp*");
    expect(config.port).toBe(3000);
    expect(config.db_path).toContain("notebook.db");
  });

  const DEFAULT_SOURCES = [
    "~/.claude/projects",
    "~/.codex/sessions",
    "~/.gemini/antigravity-cli/conversations",
  ];

  test("loadConfig returns default when no file exists", () => {
    const config = loadConfig(join(tempDir, "nonexistent.json"));
    expect(config.sources).toEqual(DEFAULT_SOURCES);
  });

  test("saveConfig writes and loadConfig reads back", () => {
    const configPath = join(tempDir, "config.json");
    const config: Config = {
      sources: ["/custom/path"],
      exclude: ["test-*"],
      db_path: join(tempDir, "test.db"),
      port: 4000,
      day_start_hour: 5,
      summary_instructions: "",
      remote_sources: [],
      auto_sync_interval: 60,
    };
    saveConfig(configPath, config);
    const loaded = loadConfig(configPath);
    expect(loaded).toEqual(config);
  });

  test("migrates the oldest legacy default (Claude only) forward", () => {
    const configPath = join(tempDir, "legacy-config.json");
    writeFileSync(configPath, JSON.stringify({ sources: ["~/.claude/projects"] }));

    const loaded = loadConfig(configPath);
    expect(loaded.sources).toEqual(DEFAULT_SOURCES);
  });

  test("migrates the Claude+Codex legacy default forward to include Antigravity", () => {
    const configPath = join(tempDir, "legacy-config-2.json");
    writeFileSync(
      configPath,
      JSON.stringify({ sources: ["~/.claude/projects", "~/.codex/sessions"] })
    );

    const loaded = loadConfig(configPath);
    expect(loaded.sources).toEqual(DEFAULT_SOURCES);
  });

  test("does not migrate a custom multi-source config that omits Antigravity", () => {
    const configPath = join(tempDir, "custom-multi.json");
    writeFileSync(
      configPath,
      JSON.stringify({ sources: ["~/.claude/projects", "/my/other/path"] })
    );

    const loaded = loadConfig(configPath);
    expect(loaded.sources).toEqual(["~/.claude/projects", "/my/other/path"]);
  });

  test("does not migrate custom single-source configs", () => {
    const configPath = join(tempDir, "custom-config.json");
    writeFileSync(configPath, JSON.stringify({ sources: ["/custom/path"] }));

    const loaded = loadConfig(configPath);
    expect(loaded.sources).toEqual(["/custom/path"]);
  });
});

describe("expandPath", () => {
  test("expands leading ~/ to home directory", () => {
    const result = expandPath("~/.claude/projects");
    expect(result).toBe(join(homedir(), ".claude/projects"));
  });

  test("leaves absolute paths unchanged", () => {
    const abs = "/usr/local/bin";
    expect(expandPath(abs)).toBe(abs);
  });

  test("leaves relative paths unchanged", () => {
    expect(expandPath("relative/path")).toBe("relative/path");
  });

  test("does not expand ~ without trailing slash", () => {
    expect(expandPath("~")).toBe("~");
  });
});
