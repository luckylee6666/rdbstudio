# rdbstudio

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-blueviolet?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.77+-dea584?logo=rust)](https://www.rust-lang.org/)

**Modern cross-platform database GUI** — A Navicat-style SQL workbench for SQLite, PostgreSQL, MySQL, and Redis, built with Tauri 2 + React + sqlx.

> Status: **early preview** (v0.1.0). Core features work; expect rough edges before v1.0.

## Features

- **Four drivers in one binary**: SQLite · PostgreSQL · MySQL · Redis
- **SQL editor**: CodeMirror 6, multi-statement execution, EXPLAIN, format (sql-formatter)
- **Data grid**: virtualized scrolling (`@tanstack/react-virtual`), inline edit, NULL handling, pretty JSON viewer
- **Table designer**: column/index editing with live DDL preview before apply
- **ER diagram**: `@xyflow/react` + dagre auto-layout
- **CSV import / export**: streamed through Rust, no browser blob round-trip
- **Redis viewer**: type-aware key viewer (string / hash / list / set / zset / stream / JSON) with TTL display, paginated SCAN
- **Connection groups**: drag-and-drop into folders, persisted locally
- **Bilingual UI**: 中文 + English

## Screenshots

<!-- Add screenshots in docs/img/ and reference them here -->
_Screenshots coming soon._

## Install

### Pre-built (Beta — coming)

Pre-built installers will be published on the [Releases](https://github.com/luckylee6666/rdbstudio/releases) page once code signing is set up. For now, build from source.

### Build from source

Requires:
- **Rust** 1.77+ (`rustup install stable`)
- **Node** 20+ and **pnpm** 10+
- **OS deps**: see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone git@github.com:luckylee6666/rdbstudio.git
cd rdbstudio
pnpm install
pnpm tauri:dev     # dev mode
pnpm tauri:build   # release bundle in src-tauri/target/release/bundle/
```

## Keyboard shortcuts

| Action | Mac | Windows / Linux |
|---|---|---|
| Run query (or selection) | ⌘↵ | Ctrl+↵ |
| Format SQL | ⌘⇧F | Ctrl+Shift+F |
| Command palette | ⌘K | Ctrl+K |
| New query tab | ⌘T | Ctrl+T |
| Close tab | ⌘W | Ctrl+W |
| Editor find (CodeMirror) | ⌘F | Ctrl+F |
| Toggle theme | (Settings) | (Settings) |

See **Settings → Shortcuts** in-app for the full list.

## Roadmap

- **v0.2** — toast notifications, error boundary, P0 polish, signed macOS build
- **v0.3** — Redis write editing (SET/HSET/...), SSH tunnel, SQL snippets
- **v0.4** — SSL certificate config, batch row editing, SQL/JSON import
- **v1.0** — auto-update, crash reporting, full Navicat parity audit

Track progress: [milestones](https://github.com/luckylee6666/rdbstudio/milestones).

## Tech stack

- **Frontend**: Tauri 2 + React 18 + TypeScript + Vite 6 + Tailwind 3 + Radix UI
- **Editor**: CodeMirror 6 (`@codemirror/lang-sql`)
- **Diagrams**: `@xyflow/react` + dagre
- **State**: Zustand
- **Backend**: Rust + sqlx 0.8 (sqlite / postgres / mysql) + redis 0.27 + tokio + keyring + csv

## Contributing

1. Fork → branch → commit → PR.
2. Run `pnpm test` (Vitest) and `cd src-tauri && cargo test` before pushing.
3. Keep TypeScript `tsc --noEmit` clean — no `any` unless justified in a comment.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with PremiumSoft / Navicat. "Navicat" is a trademark of its respective owner; rdbstudio is an independent, open-source alternative inspired by its interface conventions.
