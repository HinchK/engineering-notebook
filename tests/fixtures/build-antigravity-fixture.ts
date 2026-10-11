/**
 * Builds `tests/fixtures/test-antigravity-session-1.db` — a small but real
 * Antigravity (`agy`) conversation database, so the parser has a committed
 * fixture without shipping any user's actual session data.
 *
 * Run: `bun run tests/fixtures/build-antigravity-fixture.ts`
 * (also called from `beforeAll` in the tests so the two never drift).
 *
 * The fixture deliberately exercises the hard part: user turns are recovered
 * from a sliding `.30.19` window across several `steps` rows of `step_type` 23,
 * some cumulative and some scrolled, plus a consecutive-duplicate artifact.
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";

// --- protobuf encoding helpers ---

function uvarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

const tag = (field: number, wire: number): number[] => uvarint((field << 3) | wire);

/** length-delimited (wire 2) */
const ld = (field: number, bytes: number[]): number[] => [
  ...tag(field, 2),
  ...uvarint(bytes.length),
  ...bytes,
];

/** varint field (wire 0) */
const vi = (field: number, n: number): number[] => [...tag(field, 0), ...uvarint(n)];

const str = (field: number, s: string): number[] =>
  ld(field, Array.from(new TextEncoder().encode(s)));

const u8 = (parts: number[]): Uint8Array => new Uint8Array(parts);

/** step envelope with a timestamp at `.5.1.1` (seconds). */
const envelope = (tsSeconds: number, inner: number[]): number[] =>
  ld(5, [...ld(1, vi(1, tsSeconds)), ...inner]);

/** type-23 trajectory snapshot: repeated `.30.19` user-turn window. */
const trajectoryStep = (tsSeconds: number, window: string[]): Uint8Array =>
  u8([
    ...vi(1, 23),
    ...envelope(tsSeconds, []),
    ...ld(30, window.flatMap((t) => str(19, t))),
  ]);

/** type-15 assistant step: message text at `.20.1` (with its `.20.8` duplicate). */
const assistantStep = (tsSeconds: number, text: string): Uint8Array =>
  u8([
    ...vi(1, 15),
    ...envelope(tsSeconds, []),
    ...ld(20, [...str(1, text), ...str(8, text)]),
  ]);

// --- build ---

export const FIXTURE_PATH = join(import.meta.dir, "test-antigravity-session-1.db");

export function buildAntigravityFixture(outPath = FIXTURE_PATH): string {
  for (const suffix of ["", ".db-wal", ".db-shm"]) {
    if (existsSync(outPath + suffix)) unlinkSync(outPath + suffix);
  }

  const db = new Database(outPath, { create: true });
  db.run(`
    CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
    CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));
  `);

  const TRAJ = "11111111-1111-4111-8111-111111111111";
  const CASCADE = "22222222-2222-4222-8222-222222222222";

  db.query(
    "INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?,?,?,?)"
  ).run(TRAJ, CASCADE, 4, 17);

  // trajectory_metadata_blob: workspace at .1.1 (file://) + git branch at .1.4
  db.query("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
    u8(ld(1, [...str(1, "file:///Users/testuser/projects/fixtureapp"), ...str(4, "main")]))
  );

  // gen_metadata: model display name at .1.21
  db.query("INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, 0)").run(
    u8(ld(1, str(21, "Gemini 3.5 Flash (High)")))
  );

  const T0 = 1_780_000_000;
  const steps: { type: number; payload: Uint8Array }[] = [
    { type: 23, payload: trajectoryStep(T0 + 0, ["Set up the project skeleton"]) },
    { type: 15, payload: assistantStep(T0 + 5, "I will create the directory layout.") },
    { type: 15, payload: assistantStep(T0 + 9, "Done. The skeleton is in place.") },
    // cumulative snapshot: first turn still present, second turn appended
    {
      type: 23,
      payload: trajectoryStep(T0 + 20, [
        "Set up the project skeleton",
        "Now add a health-check endpoint",
      ]),
    },
    { type: 15, payload: assistantStep(T0 + 25, "Added GET /healthz returning 200.") },
    // scrolled window: first turn dropped, third turn appears, plus a dup artifact
    {
      type: 23,
      payload: trajectoryStep(T0 + 40, [
        "Now add a health-check endpoint",
        "Write a test for it",
        "Write a test for it",
      ]),
    },
    { type: 15, payload: assistantStep(T0 + 45, "Wrote healthz.test.ts — it passes.") },
  ];

  const ins = db.query(
    "INSERT INTO steps (idx, step_type, status, step_payload, step_format) VALUES (?,?,?,?,0)"
  );
  steps.forEach((s, i) => ins.run(i, s.type, 5, s.payload));

  db.close();
  return outPath;
}

if (import.meta.main) {
  console.log(`wrote ${buildAntigravityFixture()}`);
}
