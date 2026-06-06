# engineering-notebook

> A Bun CLI that ingests Claude Code and Codex session transcripts, generates LLM-powered daily summaries, and serves a browsable web UI for your engineering journal.

**Family:** dev-tools · **Type:** tool · **Lifecycle:** production · **Owner:** obra

## What it does
engineering-notebook scans directories of Claude Code and Codex JSONL session files, parses out the human-readable conversation, and stores it in SQLite. It then groups sessions by date and project and uses Claude to write concise journal entries (headlines, summaries, topics, open questions). A built-in web server serves a journal view, project timelines, calendar/Gantt view, full-text search, session transcripts, and an iCal feed.

## How it fits
- Depends on: — (no internal prime-radiant-inc dependencies; uses the Anthropic API directly, no internal SDK)
- Used by: —
- External: Anthropic API (Claude, via ANTHROPIC_API_KEY) for summaries; reads Claude Code and Codex session files

## Runtime & data
- Runs: Bun CLI (`ingest`, `summarize`, `serve`) and local web server on port 3000
- Data in: Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) JSONL transcripts
- Data out: SQLite store of conversations and summaries; web UI and iCal feed

<!-- Maintained by the maintaining-project-map skill. Do not hand-edit; regenerated. -->
