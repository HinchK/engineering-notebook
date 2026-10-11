import { readdirSync, statSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { Database } from "bun:sqlite";
import { parseSession } from "./parser";

/**
 * Scan source directories for session files, applying exclude patterns.
 *
 * Picks up:
 *  - `*.jsonl` (Claude Code, Codex) anywhere
 *  - `*.db`    (Antigravity / `agy`) only inside a directory named `conversations`,
 *              which is how `agy` lays them out — this keeps unrelated SQLite files
 *              (including the notebook's own DB) out of the scan. `.db-wal` /
 *              `.db-shm` sidecars are ignored.
 */
export function scanSources(
  sources: string[],
  exclude: string[]
): string[] {
  const files: string[] = [];
  const isExcluded = (name: string): boolean =>
    exclude.some((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(
        "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      return regex.test(name);
    });

  for (const source of sources) {
    const stack = [source];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          const relPath = relative(source, fullPath);
          if (isExcluded(entry) || isExcluded(relPath)) continue;
          stack.push(fullPath);
          continue;
        }

        if (entry.endsWith(".jsonl")) {
          files.push(fullPath);
        } else if (
          entry.endsWith(".db") &&
          basename(dirname(fullPath)) === "conversations"
        ) {
          files.push(fullPath);
        }
      }
    }
  }

  return files;
}

/** True for Antigravity conversation databases (re-parsed every run — they are mutable). */
function isMutableSource(file: string): boolean {
  return file.endsWith(".db");
}

/** Ingest session files into the database */
export function ingestSessions(
  files: string[],
  db: Database,
  force = false
): { ingested: number; skipped: number; errors: string[] } {
  let ingested = 0;
  let skipped = 0;
  const errors: string[] = [];

  const checkStmt = db.query("SELECT id FROM sessions WHERE source_path = ?");
  const checkSessionId = db.query("SELECT id FROM sessions WHERE id = ?");
  const checkCounts = db.query(
    "SELECT message_count, ended_at FROM sessions WHERE id = ?"
  );
  const insertProject = db.prepare(`
    INSERT INTO projects (id, path, display_name, session_count)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, parent_session_id, project_id, project_path, source_path, started_at, ended_at, git_branch, version, message_count, is_subagent, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertConvo = db.prepare(`
    INSERT INTO conversations (session_id, conversation_markdown, extracted_at)
    VALUES (?, ?, datetime('now'))
  `);
  const deleteConvo = db.prepare(`DELETE FROM conversations WHERE session_id = ?`);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);

  for (const file of files) {
    const mutable = isMutableSource(file);

    // Mutable sources (Antigravity .db) are re-parsed every run; the skip-by-path
    // fast path only applies to append-only JSONL files.
    if (!force && !mutable) {
      const existing = checkStmt.get(file);
      if (existing) {
        skipped++;
        continue;
      }
    }

    try {
      const session = parseSession(file);

      if (session.messageCount === 0) {
        skipped++;
        continue;
      }

      // Session already ingested?
      if (!force) {
        const existingById = checkCounts.get(session.sessionId) as
          | { message_count: number; ended_at: string | null }
          | null;
        if (existingById) {
          const unchanged =
            existingById.message_count === session.messageCount &&
            existingById.ended_at === session.endedAt;
          if (unchanged || !mutable) {
            // JSONL: same session seen under multiple project dirs — skip.
            // Mutable: nothing new since last run — skip.
            skipped++;
            continue;
          }
          // Mutable source grew — fall through and replace it below.
        }
      }

      const projectId = session.projectName;
      const replaceExisting = force || (mutable && !!checkSessionId.get(session.sessionId));

      db.transaction(() => {
        if (replaceExisting) {
          deleteConvo.run(session.sessionId);
          deleteSession.run(session.sessionId);
        }
        insertProject.run(
          projectId,
          session.projectPath,
          session.projectName
        );
        const isSubagent = file.includes("/subagents/") ? 1 : 0;
        insertSession.run(
          session.sessionId,
          session.parentSessionId,
          projectId,
          session.projectPath,
          file,
          session.startedAt,
          session.endedAt,
          session.gitBranch,
          session.version,
          session.messageCount,
          isSubagent
        );
        insertConvo.run(session.sessionId, session.toMarkdown());
      })();

      ingested++;
    } catch (err) {
      errors.push(`${file}: ${err}`);
    }
  }

  // Update project aggregate fields
  db.exec(`
    UPDATE projects SET
      first_session_at = (SELECT MIN(started_at) FROM sessions WHERE sessions.project_id = projects.id),
      last_session_at = (SELECT MAX(started_at) FROM sessions WHERE sessions.project_id = projects.id),
      session_count = (SELECT COUNT(*) FROM sessions WHERE sessions.project_id = projects.id)
  `);

  return { ingested, skipped, errors };
}
