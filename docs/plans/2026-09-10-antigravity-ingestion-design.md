# Antigravity (agy) session ingestion — format notes & design

**Date:** 2026-09-10
**Goal:** Ingest Antigravity CLI (`agy` / Gemini) sessions into the notebook alongside
Claude Code and Codex, at full-transcript fidelity.

## Storage layout

Unlike Claude Code / Codex (one JSONL file per session), `agy` stores **one SQLite
database per conversation**:

```
~/.gemini/antigravity-cli/conversations/<conversation-uuid>.db          ← agy CLI  (in scope)
~/.gemini/antigravity-cli/conversations/<uuid>.db-wal / .db-shm         ← WAL sidecars, ignore
~/.gemini/antigravity/conversations/<uuid>.db  and  <uuid>.pb           ← IDE app, OUT of scope
```

A plaintext index also exists at
`~/.gemini/antigravity-cli/cache/conversation_metadata.json`
(`{conversations: {<id>: {summary: {Preview, NumSteps, UpdatedAt, WorkspaceURIs, ...}}}}`).
We do not need it — everything is in the per-conversation `.db`.

## Schema (per-conversation `.db`)

| table | use |
|---|---|
| `trajectory_meta` | `trajectory_id`, `cascade_id`, `trajectory_type` (4), `source` (17) |
| `trajectory_metadata_blob` | 1 row, protobuf: workspace `file://` URIs, git remote, branch, commit |
| `steps` | the transcript. `idx` (chronological), `step_type` (int), `status` (int), `step_payload` (protobuf blob), + mostly-unused `metadata`/`task_details`/`error_details` blobs |
| `gen_metadata` | per-LLM-call token accounting + model name ("Gemini 3.5 Flash (High)") |
| `executor_metadata`, `parent_references`, `battle_mode_infos` | not needed |

`render_info` column is always NULL. `step_format` observed = 0.

## `step_payload` protobuf (reverse-engineered, no schema)

Wire format only. Top level: field 1 = `step_type` (redundant with column), field 5 =
envelope `{ 1: {1:sec,2:nsec} timestamp, 12: cascade-id, 20: {1:trajectory,4:conversation} }`.
Content lives at **step-type-specific field numbers**:

| step_type | meaning | text location(s) inside `step_payload` |
|---|---|---|
| **23** | trajectory snapshot / plan (1+ per convo, cumulative) | `.30.19` **repeated** = system prompt (entry 0, only for autonomous runs) then **each user turn**; `.30.5` = running `<summary>`; `.30.4` = title; `.30.18.2/.3` = knowledge items (old/new file text) |
| **15** | assistant step (most common) | `.20.1` = **assistant message / narration** ("I will…", final answers); `.20.3` = **thinking** ("**Analyzing…**"); `.20.8` = dup of `.20.1`; `.20.7.3` = tool-call args JSON |
| 8 | read tool (`view_file`) | `.5.4.2` name, `.5.4.3` args; result text `.14.4` |
| 21 | `run_command` | `.5.31` label; command output `.28.21.1` / `.28.23` / `.28.25` |
| 38 | `call_mcp_tool` | `.5.31` label; result `.47.3` |
| 5 | `write_to_file` / `replace_file_content` | `.5.4.3` args (`CodeContent`), new file text `.10.2.*` |
| 7 | `grep_search` | results `.13.4` |
| 9 | `list_dir` | results `.15.3` |
| 101 | subtask/todo mgmt | `.114.*` |
| 132 | `manage_task` | `.140.*` |
| 14 | turn/trajectory boundary marker | `.19.*` (no useful prose) |
| 17 | tool-call parse error | `.24.3.*` error text |

Tool **call args** and **results** are plaintext in the fields above. There is *also* a
redundant **encrypted** copy of each tool result at `.5.4.7.2.1` (constant 5-byte prefix
`01 0c 39 d6 c7`) — we ignore it; the plaintext is enough. **We do not attempt to
decrypt anything.**

`gen_metadata` row protobuf: `.19` = model slug (`gemini-3-flash-a`), `.21` = display
name (`Gemini 3.5 Flash (High)`), `.1.4` = token counts.

## Extraction strategy

- **sessionId** = `trajectory_meta.cascade_id` (the conversation UUID = filename).
- **projectPath / workspace** = first `file://` URI in `trajectory_metadata_blob`
  (`.1`/`.2`). Most CLI conversations record no workspace there (`ProjectID` is
  just `"default-cli-project"`), so fall back to **inferring** it from the
  filesystem paths the tools touched: collect every `file:///Users|home/...`
  path from step payloads (skipping `~/.gemini`, `~/.claude` and other dot-dir
  tooling internals), then pick the deepest directory that still covers ~all of
  them. ~Half of this user's sessions (herdr orchestration, memory queries,
  scratch work, one-word prompts) genuinely have no project and stay `unknown` —
  that is correct, not a bug to paper over.
- **gitBranch** = `trajectory_metadata_blob` `.1.4`; **version** = model display
  name from `gen_metadata` `.1.21` (e.g. "Gemini 3.5 Flash (High)").
- **startedAt / endedAt** = min/max step timestamp (`step_payload .5.1`).
- **messages**, in `idx` order:
  - user turns: union of `.30.19` across all type-23 steps, deduped, order-preserved;
    drop entry 0 when it is the autonomous system/role prompt.
  - assistant turns: type-15 `.20.1` (message) and optionally `.20.3` (thinking).
  - tool activity: terse fold-in.
- **assistantDisplayName** = `"Antigravity"`.

## Code integration

1. `config.ts` — add `~/.gemini/antigravity-cli/conversations` to `defaultConfig().sources`
   + migration.
2. `ingest.ts::scanSources` — also collect `*.db` files (not `.db-wal`/`.db-shm`).
3. `parser.ts::parseSession` — if `filePath` ends `.db`, dispatch to new
   `parseAntigravitySession(filePath)` (opens with `bun:sqlite` `{ readonly: true }`).
   Non-agy `.db` → return `messageCount: 0` so `ingestSessions` skips it quietly.
4. New `src/antigravity.ts` — tiny protobuf varint/wire reader (no deps) + the parser,
   returning the existing `ParsedSession` shape.
5. Fixture: generate a small real `.db` via a committed builder script.

Out of scope: `.pb` files, the IDE `~/.gemini/antigravity/` dir, decryption, the
`conversation_metadata.json` index.
