import { describe, test, expect, beforeAll } from "bun:test";
import { parseAntigravitySession, inferWorkspace } from "./antigravity";
import { parseSession } from "./parser";
import {
  buildAntigravityFixture,
  FIXTURE_PATH as fixture,
} from "../tests/fixtures/build-antigravity-fixture";

describe("parseAntigravitySession", () => {
  beforeAll(() => {
    // Regenerate from the builder so the committed .db can never drift from it.
    buildAntigravityFixture();
  });

  test("extracts session metadata", () => {
    const s = parseAntigravitySession(fixture);
    expect(s.sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(s.projectPath).toBe("/Users/testuser/projects/fixtureapp");
    expect(s.projectName).toBe("fixtureapp");
    expect(s.userDisplayName).toBe("testuser");
    expect(s.assistantDisplayName).toBe("Antigravity");
    expect(s.gitBranch).toBe("main");
    expect(s.version).toBe("Gemini 3.5 Flash (High)");
    expect(s.startedAt).toBeTruthy();
    expect(s.endedAt).toBeTruthy();
    expect(s.parentSessionId).toBeNull();
  });

  test("reconstructs user turns from the sliding .30.19 window and interleaves them", () => {
    const s = parseAntigravitySession(fixture);
    expect(s.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:Set up the project skeleton",
      "assistant:I will create the directory layout.",
      "assistant:Done. The skeleton is in place.",
      "user:Now add a health-check endpoint",
      "assistant:Added GET /healthz returning 200.",
      "user:Write a test for it",
      "assistant:Wrote healthz.test.ts — it passes.",
    ]);
    expect(s.messageCount).toBe(7);
  });

  test("collapses the consecutive-duplicate window artifact", () => {
    const s = parseAntigravitySession(fixture);
    const userTurns = s.messages.filter((m) => m.role === "user");
    // "Write a test for it" appears twice in the last window; keep it once.
    expect(userTurns.filter((m) => m.text === "Write a test for it")).toHaveLength(1);
  });

  test("generates conversation markdown", () => {
    const s = parseAntigravitySession(fixture);
    const md = s.toMarkdown();
    expect(md).toContain("# Session: fixtureapp");
    expect(md).toContain("**Branch:** main");
    expect(md).toContain("**testuser (2026-05-28 20:26):** Set up the project skeleton");
    expect(md).toContain("**Antigravity (");
  });

  test("parseSession dispatches .db files to the Antigravity parser", () => {
    const viaDispatch = parseSession(fixture);
    const direct = parseAntigravitySession(fixture);
    expect(viaDispatch.sessionId).toBe(direct.sessionId);
    expect(viaDispatch.assistantDisplayName).toBe("Antigravity");
    expect(viaDispatch.messageCount).toBe(direct.messageCount);
  });

  describe("inferWorkspace (fallback when no workspace is recorded)", () => {
    test("picks the deepest directory covering a majority of touched paths", () => {
      expect(
        inferWorkspace([
          "/Users/dev/code/myapp/src/a.ts",
          "/Users/dev/code/myapp/src/b.ts",
          "/Users/dev/code/myapp/README.md",
          "/Users/dev/notes/todo.md",
        ])
      ).toBe("/Users/dev/code/myapp");
    });

    test("never returns a file path", () => {
      const r = inferWorkspace(["/Users/dev/code/solo/only.ts"]);
      expect(r).toBe("/Users/dev/code/solo");
    });

    test("returns empty for no usable paths", () => {
      expect(inferWorkspace([])).toBe("");
      expect(inferWorkspace(["/etc/hosts"])).toBe("");
    });
  });

  test("returns an empty session (skipped) for a non-Antigravity .db", () => {
    // The notebook's own DB or any unrelated SQLite file.
    const { Database } = require("bun:sqlite");
    const { rmSync } = require("fs");
    const tmp = fixture.replace(/[^/]+$/, ".not-agy.db");
    const db = new Database(tmp, { create: true });
    db.run("CREATE TABLE foo (x)");
    db.close();
    try {
      const s = parseAntigravitySession(tmp);
      expect(s.messageCount).toBe(0);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
