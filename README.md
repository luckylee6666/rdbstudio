# rdbstudio

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-blueviolet?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.77+-dea584?logo=rust)](https://www.rust-lang.org/)

**Modern cross-platform database GUI** — A Navicat-style SQL workbench for SQLite, PostgreSQL, MySQL, and Redis, built with Tauri 2 + React + sqlx.

> Status: **v0.1.0** — first stable release. macOS (Apple Silicon) and Windows x64 installers on the [Releases](https://github.com/luckylee6666/rdbstudio/releases) page.

## Features

**Query & analyze**
- SQL editor (CodeMirror 6): column-aware autocomplete, SQL formatting, snippets library
- Multi-statement scripts run **atomically in one transaction** — any failure rolls the whole script back with the failing statement pinpointed
- Query cancellation mid-flight; results capped at 10k rows with an explicit truncation banner (no more frozen UI on `SELECT *`)
- **Visual EXPLAIN**: PostgreSQL / SQLite query plans rendered as an auto-laid-out node graph, with cost hotspots highlighted by *self* cost
- Query history with re-run, result export as CSV / JSON / SQL INSERT

**Data & schema**
- Virtualized data grid: inline editing (multi-row-match writes are rejected server-side), FK value jump, copy row as INSERT / CSV / JSON, pretty JSON cell viewer
- Table designer with live DDL preview; create table / schema, rename, truncate, duplicate structure
- ER diagram with automatic layout
- CSV import (batched multi-row INSERTs with per-row error reporting) and table export
- **Whole-database dump & restore**: SQLite via `VACUUM INTO`, PostgreSQL via `pg_dump`/`psql`, MySQL via `mysqldump`/`mysql` — client binaries auto-discovered, passwords never touch the command line

**Redis**
- Type-aware key viewer (string / hash / list / set / zset / stream / JSON) with TTL, paginated SCAN
- In-place value editing; field/member renames run as **guarded atomic Lua scripts** (no clobbering, no lost values)

**Connections & safety**
- Connection groups (drag-and-drop), environment color tags, pin favorites
- **Read-only mode** enforced server-side across every write path — including data-modifying CTEs
- SSH tunnels (key / agent / password¹), SSL/TLS with certificate verification modes
- Passwords stored in the system keychain (macOS Keychain / Windows Credential Manager), never in config files
- Corrupt config/history files are quarantined instead of silently wiped

**Workspace**
- Tabs, editor buffers, and layout persist across restarts
- Command palette (open any table / key / action), sidebar live filter for large schemas
- Bilingual UI (中文 / English), dark & light themes

¹ SSH password auth is macOS/Linux only; Windows uses key files or ssh-agent.

## Install

### Pre-built (unsigned)

Tagged releases publish installers to [Releases](https://github.com/luckylee6666/rdbstudio/releases):

- **macOS arm64** — `.dmg` (Apple Silicon)
- **Windows x64** — `.msi` (en-US / zh-CN) or `.exe` setup

The builds are not code-signed yet, so first launch needs one extra step:

- **macOS**: double-click shows "Apple could not verify…" → click **Done** → **System Settings → Privacy & Security** → scroll down → **Open Anyway**. (The app is ad-hoc signed, so it will *not* show the dead-end "app is damaged" dialog.)
- **Windows**: SmartScreen → **More info** → **Run anyway**. Windows 10 may prompt to install the WebView2 runtime; Windows 11 ships it.

Signed / notarized builds will land once code-signing certificates are in place.

### Build from source

Requires:
- **Rust** 1.77+ (`rustup install stable`)
- **Node** 20+ and **pnpm** 10+
- **OS deps**: see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone git@github.com:luckylee6666/rdbstudio.git
cd rdbstudio
pnpm install
pnpm tauri dev     # dev mode
pnpm tauri build   # release bundle in src-tauri/target/release/bundle/
```

## Keyboard shortcuts

| Action | Mac | Windows / Linux |
|---|---|---|
| Run query (or selection) | ⌘↵ | Ctrl+Enter |
| Format SQL | ⌘⇧F | Ctrl+Shift+F |
| Command palette | ⌘K | Ctrl+K |
| New query tab | ⌘T | Ctrl+T |
| Close tab | ⌘W | Ctrl+W |
| Toggle sidebar | ⌘B | Ctrl+B |
| Toggle theme | ⌘/ | Ctrl+/ |
| Editor find (CodeMirror) | ⌘F | Ctrl+F |

See **Settings → Shortcuts** in-app for the full list.

## Roadmap

- Code-signed + notarized builds; auto-update channel
- `EXPLAIN ANALYZE` mode (real execution timings in the plan graph)
- Dump/restore progress reporting and cancellation
- Redis Pub/Sub, Cluster, and Streams tooling

## Tech stack

- **Frontend**: Tauri 2 + React 18 + TypeScript + Vite 6 + Tailwind 3 + Radix UI
- **Editor**: CodeMirror 6 (`@codemirror/lang-sql`)
- **Diagrams**: `@xyflow/react` + dagre
- **State**: Zustand (persisted workspace)
- **Backend**: Rust + sqlx 0.8 (sqlite / postgres / mysql) + redis 0.27 + tokio + keyring + csv

## Contributing

1. Fork → branch → commit → PR.
2. Run `pnpm test` (Vitest) and `cd src-tauri && cargo test` before pushing.
3. Keep TypeScript `tsc --noEmit` clean — no `any` unless justified in a comment.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with PremiumSoft / Navicat. "Navicat" is a trademark of its respective owner; rdbstudio is an independent, open-source alternative inspired by its interface conventions.
