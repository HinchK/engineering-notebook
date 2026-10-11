import { Database } from "bun:sqlite";
import { basename } from "path";
import type { ParsedSession, ParsedMessage } from "./parser";
import { buildMarkdown } from "./parser";

/**
 * Antigravity (`agy` / Gemini) CLI session ingestion.
 *
 * Unlike Claude Code and Codex (one JSONL file per session), `agy` stores one
 * SQLite database per conversation under
 * `~/.gemini/antigravity-cli/conversations/<uuid>.db`. Message content lives in
 * undocumented protobuf blobs in the `steps` table. See
 * `docs/plans/2026-09-10-antigravity-ingestion-design.md` for the full
 * reverse-engineering notes.
 *
 * We never decrypt anything: tool call args and results are already plaintext in
 * step-type-specific fields; the redundant encrypted copy of each tool result is
 * ignored.
 */

// --- minimal, tolerant protobuf wire reader (no schema, no deps) ---

type PbField = { field: number; wire: number; value: Uint8Array | bigint };

/** Parse one protobuf message. Returns [] on any malformed input rather than throwing. */
function parseMessage(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  try {
    while (i < buf.length) {
      const [tag, ni] = readVarint(buf, i);
      i = ni;
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field === 0) return out;
      if (wire === 0) {
        const [v, nj] = readVarint(buf, i);
        i = nj;
        out.push({ field, wire, value: v });
      } else if (wire === 1) {
        out.push({ field, wire, value: buf.subarray(i, i + 8) });
        i += 8;
      } else if (wire === 2) {
        const [len, nj] = readVarint(buf, i);
        i = nj;
        const end = nj + Number(len);
        if (end > buf.length) return out;
        out.push({ field, wire, value: buf.subarray(nj, end) });
        i = end;
      } else if (wire === 5) {
        out.push({ field, wire, value: buf.subarray(i, i + 4) });
        i += 4;
      } else {
        // wire 3/4 (groups) or garbage — stop parsing this message cleanly
        return out;
      }
    }
  } catch {
    return out;
  }
  return out;
}

function readVarint(buf: Uint8Array, i: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  while (true) {
    if (i >= buf.length) throw new Error("varint overrun");
    const byte = buf[i]!;
    i++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Navigate an explicit field-number path (e.g. `[5, 1, 1]`) and return every
 * matching field. Repeated fields at the final step yield multiple results, in
 * document order. Intermediate steps recurse into all matching sub-messages.
 *
 * An explicit path is used rather than a generic "walk every string leaf"
 * because a sub-message whose bytes happen to be all-printable is
 * indistinguishable from a string by content alone.
 */
function collectAt(buf: Uint8Array, path: number[]): PbField[] {
  let frontier: Uint8Array[] = [buf];
  for (let depth = 0; depth < path.length; depth++) {
    const field = path[depth]!;
    const last = depth === path.length - 1;
    const next: Uint8Array[] = [];
    const hits: PbField[] = [];
    for (const b of frontier) {
      for (const f of parseMessage(b)) {
        if (f.field !== field) continue;
        if (last) {
          hits.push(f);
        } else if (f.wire === 2) {
          next.push(f.value as Uint8Array);
        }
      }
    }
    if (last) return hits;
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return [];
}

/** All string values at an explicit path, in document order. */
function stringsAt(buf: Uint8Array, path: number[]): string[] {
  return collectAt(buf, path)
    .filter((f) => f.wire === 2)
    .map((f) => decoder.decode(f.value as Uint8Array));
}

/** First varint value at an explicit path. */
function firstVarintAt(buf: Uint8Array, path: number[]): bigint | null {
  for (const f of collectAt(buf, path)) {
    if (f.wire === 0) return f.value as bigint;
  }
  return null;
}

/** Every string value found anywhere under the message (bounded DFS), for loose scans. */
function* allStrings(buf: Uint8Array, depth = 0): Generator<string> {
  if (depth > 12) return;
  for (const f of parseMessage(buf)) {
    if (f.wire !== 2) continue;
    const bytes = f.value as Uint8Array;
    const s = decoder.decode(bytes);
    const clean = !s.includes("�");
    if (clean && bytes.length >= 2) yield s;
    yield* allStrings(bytes, depth + 1);
  }
}

// --- step-type field maps (see the design doc for the full reverse-engineering) ---

const STEP_TYPE_ASSISTANT = 15;
const STEP_TYPE_TRAJECTORY = 23;

/** step_type 15: assistant message / narration text. */
const ASSISTANT_TEXT_PATH = [20, 1];
/** step_type 23: repeated user-turn window (sliding, overlapping across steps). */
const USER_WINDOW_PATH = [30, 19];
/** any step: envelope timestamp, seconds. */
const TIMESTAMP_PATH = [5, 1, 1];

// --- sliding-window merge ---

/** Collapse consecutive exact duplicates (an extraction artifact for the "latest" turn). */
function dedupeConsecutive(items: string[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (out.length === 0 || out[out.length - 1] !== it) out.push(it);
  }
  return out;
}

/**
 * Merge one window (last-N user turns) into the reconstructed stream by finding
 * the longest suffix of `stream` that equals a prefix of `window`, then
 * appending the rest. Returns the newly appended turns.
 */
function mergeWindow(stream: string[], window: string[]): string[] {
  const w = dedupeConsecutive(window);
  const maxK = Math.min(stream.length, w.length);
  for (let k = maxK; k > 0; k--) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (stream[stream.length - k + j] !== w[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const appended = w.slice(k);
      stream.push(...appended);
      return appended;
    }
  }
  stream.push(...w);
  return w;
}

// --- metadata extraction ---

function extractWorkspace(db: Database): {
  projectPath: string;
  gitBranch: string | null;
} {
  const row = db
    .query("SELECT data FROM trajectory_metadata_blob LIMIT 1")
    .get() as { data: Uint8Array } | null;
  if (!row?.data) return { projectPath: "", gitBranch: null };
  const data = new Uint8Array(row.data);

  let projectPath = "";
  for (const s of allStrings(data)) {
    if (s.startsWith("file://")) {
      projectPath = decodeURI(s.replace(/^file:\/\//, "").replace(/\/$/, ""));
      break;
    }
  }

  // .1.4 holds the git branch ("main"); accept any short bareword there.
  let gitBranch: string | null = null;
  const branch = stringsAt(data, [1, 4])[0];
  if (branch && /^[\w.\-/]{1,60}$/.test(branch)) gitBranch = branch;

  return { projectPath, gitBranch };
}

/**
 * Most CLI conversations have no workspace recorded in
 * `trajectory_metadata_blob` (`ProjectID` is just `"default-cli-project"`), so
 * infer it from the filesystem paths the tools actually touched: take the
 * deepest directory that covers a majority of those paths.
 */
export function inferWorkspace(paths: string[]): string {
  if (paths.length === 0) return "";
  const homeMatch = paths[0]!.match(/^(\/(?:Users|home)\/[^/]+)\//);
  const home = homeMatch?.[1];
  if (!home) return "";

  const counts = new Map<string, number>();
  for (const p of paths) {
    if (!p.startsWith(home + "/")) continue;
    const rel = p.slice(home.length + 1).split("/");
    // depth < rel.length keeps candidates as directories, never the file itself.
    for (let depth = 1; depth <= 4 && depth < rel.length; depth++) {
      const dir = home + "/" + rel.slice(0, depth).join("/");
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "";
  const total = paths.length;
  // Walk down coverage tiers: the project root is the deepest directory that
  // still accounts for (nearly) all the touched paths — going deeper than the
  // root drops coverage as siblings (src/, docs/, tests/) diverge.
  for (const frac of [0.9, 0.7, 0.5]) {
    const need = Math.max(2, total * frac);
    let best = "";
    for (const [dir, c] of counts) {
      if (c >= need && dir.length > best.length) best = dir;
    }
    if (best) return best;
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length
  )[0]![0];
}

function extractModel(db: Database): string | null {
  const rows = db
    .query("SELECT data FROM gen_metadata ORDER BY idx LIMIT 20")
    .all() as { data: Uint8Array }[];
  for (const r of rows) {
    if (!r.data) continue;
    const data = new Uint8Array(r.data);
    // .1.21 = display name ("Gemini 3.5 Flash (High)"); .1.19 = slug ("gemini-3-flash-a").
    const display = stringsAt(data, [1, 21])[0];
    if (display && /gemini|claude|gpt|flash|pro/i.test(display)) return display;
    for (const s of allStrings(data)) {
      if (/^(gemini|claude|gpt)[\w.\-]*$/i.test(s)) return s;
    }
  }
  return null;
}

// --- ISO timestamp from protobuf {seconds, nanos} ---

function tsToIso(seconds: bigint | null): string {
  if (seconds === null || seconds <= 0n) return "";
  return new Date(Number(seconds) * 1000).toISOString();
}

/**
 * Parse an Antigravity conversation `.db`. Returns a `ParsedSession` with
 * `messageCount === 0` (so the ingester skips it quietly) when the file is not a
 * recognizable agy conversation database.
 */
export function parseAntigravitySession(filePath: string): ParsedSession {
  const fallbackId = basename(filePath, ".db");
  // `immutable=1` lets SQLite read the file with no locking and without touching
  // the -wal/-shm sidecars — required because `agy` may hold the DB open, and a
  // plain `readonly` open of a WAL database fails ("unable to open database
  // file"). Any steps still only in an uncommitted -wal are picked up on the
  // next ingest run (agy .db sources are re-parsed every run).
  const uri = `file:${encodeURI(filePath)}?immutable=1`;
  const db = new Database(uri, { readonly: true });
  try {
    const tables = new Set(
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name)
    );
    if (!tables.has("steps") || !tables.has("trajectory_meta")) {
      return emptySession(fallbackId, filePath);
    }

    const meta = db
      .query("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1")
      .get() as { trajectory_id: string; cascade_id: string } | null;
    const sessionId = meta?.cascade_id || meta?.trajectory_id || fallbackId;

    const ws = extractWorkspace(db);
    let projectPath = ws.projectPath;
    const gitBranch = ws.gitBranch;
    const model = extractModel(db);

    const steps = db
      .query(
        "SELECT idx, step_type, step_payload FROM steps ORDER BY idx"
      )
      .all() as { idx: number; step_type: number; step_payload: Uint8Array | null }[];

    const messages: ParsedMessage[] = [];
    const userStream: string[] = [];
    const filePaths: string[] = [];
    let firstTs = "";
    let lastTs = "";

    for (const step of steps) {
      if (!step.step_payload) continue;
      const payload = new Uint8Array(step.step_payload);
      const ts = tsToIso(firstVarintAt(payload, TIMESTAMP_PATH));
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      // Collect the paths tools touched, for workspace inference (see below).
      // Skip oversized payloads (browser/DOM snapshots) — the workspace shows up
      // in ordinary tool-call steps, which are small.
      if (!projectPath && payload.length < 65536) {
        for (const s of allStrings(payload)) {
          const m = s.match(/file:\/\/(\/(?:Users|home)\/[^/]+\/[^"'\s?]+)/);
          if (!m) continue;
          const path = decodeURI(m[1]!);
          // Skip agent/tool internals (~/.gemini, ~/.claude, ~/.config, …) —
          // every session references its own brain/task-log files there.
          const rel = path.replace(/^\/(?:Users|home)\/[^/]+\//, "");
          if (rel.startsWith(".")) continue;
          filePaths.push(path);
        }
      }

      if (step.step_type === STEP_TYPE_TRAJECTORY) {
        const window = stringsAt(payload, USER_WINDOW_PATH)
          .map((s) => s.trim())
          .filter(Boolean);
        if (window.length === 0) continue;
        // An autonomous run's leading role/system prompt is still user-authored
        // intent that drove the session — keep every window entry as a user turn.
        const appended = mergeWindow(userStream, window);
        for (const turn of appended) {
          messages.push({ role: "user", text: turn, timestamp: ts });
        }
      } else if (step.step_type === STEP_TYPE_ASSISTANT) {
        // Assistant message text at .20.1 (agy stores a verbatim copy at .20.8,
        // which this path does not touch). Thinking blocks (.20.3) and tool
        // chatter are deliberately left out to keep message counts comparable
        // with the JSONL parsers.
        const seen = new Set<string>();
        for (const raw of stringsAt(payload, ASSISTANT_TEXT_PATH)) {
          const t = raw.trim();
          if (!t || seen.has(t)) continue;
          seen.add(t);
          messages.push({ role: "assistant", text: t, timestamp: ts });
        }
      }
    }

    if (!projectPath) projectPath = inferWorkspace(filePaths);

    const projectName = projectNameFromPath(projectPath);
    const userDisplayName = userDisplayNameFromPath(projectPath);

    return {
      sessionId,
      parentSessionId: null,
      projectPath,
      projectName,
      userDisplayName,
      assistantDisplayName: "Antigravity",
      gitBranch,
      version: model,
      startedAt: firstTs,
      endedAt: lastTs || null,
      messages,
      messageCount: messages.length,
      toMarkdown() {
        return buildMarkdown({
          projectName,
          projectPath,
          gitBranch,
          userDisplayName,
          assistantDisplayName: "Antigravity",
          firstTimestamp: firstTs || null,
          lastTimestamp: lastTs || null,
          messages,
        });
      },
    };
  } finally {
    db.close();
  }
}

function emptySession(sessionId: string, filePath: string): ParsedSession {
  return {
    sessionId,
    parentSessionId: null,
    projectPath: "",
    projectName: "unknown",
    userDisplayName: "User",
    assistantDisplayName: "Antigravity",
    gitBranch: null,
    version: null,
    startedAt: "",
    endedAt: null,
    messages: [],
    messageCount: 0,
    toMarkdown: () => `# Session: unknown\n(not an Antigravity conversation: ${filePath})\n`,
  };
}

// Local copies of parser.ts path helpers (kept private there historically).
function projectNameFromPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}

function userDisplayNameFromPath(projectPath: string): string {
  const unix = projectPath.match(/^\/(?:Users|home)\/([^/]+)/);
  if (unix?.[1]) return unix[1];
  const win = projectPath.match(/^[A-Za-z]:\\Users\\([^\\]+)/);
  if (win?.[1]) return win[1];
  return "User";
}
