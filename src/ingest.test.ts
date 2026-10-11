import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { scanSources, ingestSessions } from "./ingest";
import { initDb, closeDb } from "./db";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildAntigravityFixture } from "../tests/fixtures/build-antigravity-fixture";

beforeAll(() => {
  buildAntigravityFixture();
});


describe("scanSources", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-ingest-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("finds .jsonl files in project directories", () => {
    const projectDir = join(tempDir, "-Users-test-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), "{}");
    writeFileSync(join(projectDir, "session-2.jsonl"), "{}");
    writeFileSync(join(projectDir, "memory"), "{}");

    const files = scanSources([tempDir], []);
    expect(files.length).toBe(2);
  });

  test("excludes matching patterns", () => {
    const included = join(tempDir, "-Users-test-myapp");
    const excluded = join(tempDir, "-private-tmp");
    mkdirSync(included, { recursive: true });
    mkdirSync(excluded, { recursive: true });
    writeFileSync(join(included, "s1.jsonl"), "{}");
    writeFileSync(join(excluded, "s2.jsonl"), "{}");

    const files = scanSources([tempDir], ["-private-tmp*"]);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("myapp");
  });

  test("finds .jsonl files in nested directories", () => {
    const nested = join(tempDir, "2026", "02", "24");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "rollout-1.jsonl"), "{}");

    const files = scanSources([tempDir], []);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("rollout-1.jsonl");
  });

  test("finds .db files only inside a 'conversations' directory", () => {
    const convDir = join(tempDir, "antigravity-cli", "conversations");
    const otherDir = join(tempDir, "somewhere-else");
    mkdirSync(convDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(convDir, "abc.db"), "");
    writeFileSync(join(convDir, "abc.db-wal"), ""); // sidecar, ignored
    writeFileSync(join(convDir, "abc.db-shm"), ""); // sidecar, ignored
    writeFileSync(join(otherDir, "notebook.db"), ""); // unrelated SQLite file

    const files = scanSources([tempDir], []);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(join("conversations", "abc.db"));
  });
});

describe("ingestSessions", () => {
  let tempDir: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notebook-ingest-test-"));
    db = initDb(join(tempDir, "test.db"));
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ingests a session file into the database", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);

    const sessions = db.query("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);

    const convos = db.query("SELECT * FROM conversations").all();
    expect(convos.length).toBe(1);

    const projects = db.query("SELECT * FROM projects").all();
    expect(projects.length).toBe(1);
  });

  test("skips already-ingested sessions", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("re-ingests sessions when force=true", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const first = ingestSessions([sessionFile], db);
    expect(first.ingested).toBe(1);
    expect(first.errors.length).toBe(0);

    const second = ingestSessions([sessionFile], db, true);
    expect(second.ingested).toBe(1);
    expect(second.skipped).toBe(0);
    expect(second.errors.length).toBe(0);

    const sessions = db.query("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);

    const convos = db.query("SELECT * FROM conversations").all();
    expect(convos.length).toBe(1);
  });

  test("marks sessions in /subagents/ paths as is_subagent=1", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const subagentDir = join(tempDir, "-Users-test-myapp", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const sessionFile = join(subagentDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const session = db.query("SELECT is_subagent FROM sessions").get() as { is_subagent: number } | null;
    expect(session?.is_subagent).toBe(1);
  });

  test("marks regular sessions as is_subagent=0", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-session-1.jsonl");
    const projectDir = join(tempDir, "-Users-test-myapp");
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = join(projectDir, "test-session-1.jsonl");
    copyFileSync(fixturePath, sessionFile);

    ingestSessions([sessionFile], db);
    const session = db.query("SELECT is_subagent FROM sessions").get() as { is_subagent: number } | null;
    expect(session?.is_subagent).toBe(0);
  });

  test("ingests an Antigravity conversation .db", () => {
    const fixturePath = join(
      import.meta.dir,
      "../tests/fixtures/test-antigravity-session-1.db"
    );
    const convDir = join(tempDir, "antigravity-cli", "conversations");
    mkdirSync(convDir, { recursive: true });
    const dbFile = join(convDir, "conv-1.db");
    copyFileSync(fixturePath, dbFile);

    const result = ingestSessions([dbFile], db);
    expect(result.ingested).toBe(1);
    expect(result.errors).toEqual([]);

    const session = db
      .query("SELECT id, project_path, version, message_count FROM sessions")
      .get() as {
      id: string;
      project_path: string;
      version: string;
      message_count: number;
    } | null;
    expect(session?.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(session?.project_path).toBe("/Users/testuser/projects/fixtureapp");
    expect(session?.version).toBe("Gemini 3.5 Flash (High)");
    expect(session?.message_count).toBe(7);
  });

  test("re-ingests a mutable .db source when it has grown", () => {
    const fixturePath = join(
      import.meta.dir,
      "../tests/fixtures/test-antigravity-session-1.db"
    );
    const convDir = join(tempDir, "antigravity-cli", "conversations");
    mkdirSync(convDir, { recursive: true });
    const dbFile = join(convDir, "conv-1.db");
    copyFileSync(fixturePath, dbFile);

    // First ingest.
    expect(ingestSessions([dbFile], db).ingested).toBe(1);
    // Nothing changed -> skipped.
    const second = ingestSessions([dbFile], db);
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(1);

    // The conversation gains another assistant step (agy .db files are mutable).
    const { Database } = require("bun:sqlite");
    const conv = new Database(dbFile);
    const text = "One more thing done.";
    const t = Array.from(new TextEncoder().encode(text));
    const uvarint = (n: number): number[] => {
      const out: number[] = [];
      let v = n;
      while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      out.push(v);
      return out;
    };
    const ld = (f: number, b: number[]) => [
      ...uvarint((f << 3) | 2),
      ...uvarint(b.length),
      ...b,
    ];
    // step_payload = { 1: 15, 20: { 1: text, 8: text } }
    const payload = new Uint8Array([
      ...uvarint((1 << 3) | 0),
      15,
      ...ld(20, [...ld(1, t), ...ld(8, t)]),
    ]);
    conv
      .query(
        "INSERT INTO steps (idx, step_type, status, step_payload, step_format) VALUES (99, 15, 5, ?, 0)"
      )
      .run(payload);
    conv.close();

    const third = ingestSessions([dbFile], db);
    expect(third.ingested).toBe(1); // replaced

    const session = db
      .query("SELECT message_count FROM sessions")
      .get() as { message_count: number };
    expect(session.message_count).toBe(8);
    expect(db.query("SELECT COUNT(*) c FROM sessions").get()).toEqual({ c: 1 });
  });

  test("ingests a Codex session file into the database", () => {
    const fixturePath = join(import.meta.dir, "../tests/fixtures/test-codex-session-1.jsonl");
    const codexDir = join(tempDir, "2026", "02", "24");
    mkdirSync(codexDir, { recursive: true });
    const sessionFile = join(codexDir, "rollout-2026-02-24T09-00-00-019bf429-646d-70c2-a8b8-a0d69db3f01d.jsonl");
    copyFileSync(fixturePath, sessionFile);

    const result = ingestSessions([sessionFile], db);
    expect(result.ingested).toBe(1);
    expect(result.errors.length).toBe(0);

    const session = db.query("SELECT id, project_path, version, message_count FROM sessions").get() as {
      id: string;
      project_path: string;
      version: string;
      message_count: number;
    } | null;
    expect(session).toBeTruthy();
    expect(session?.id).toBe("019bf429-646d-70c2-a8b8-a0d69db3f01d");
    expect(session?.project_path).toBe("/Users/peteror/Code/engineering-notebook");
    expect(session?.version).toBe("0.99.0-alpha.23");
    expect(session?.message_count).toBe(2);
  });
});
