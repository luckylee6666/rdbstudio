# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Connection groups: drag connections into folders, persist empty groups locally.
- Redis-key viewer: dedicated tab kind that renders values by type (string / hash / list / set / zset / stream / JSON) with TTL.
- Global toast notifications and a top-level error boundary so failures stop being silent.
- Keyboard-shortcut reference in Settings.

### Changed
- CSV export now goes through the dialog plugin + a Rust `write_text_file` command (the old `<a download>` path is silently blocked in WKWebView).
- Clipboard writes route through `tauri-plugin-clipboard-manager` for cross-platform reliability.
- `window.prompt` / `window.confirm` replaced with `PromptDialog` / `ConfirmDialog` (Tauri WKWebView disables the native ones).
- Connection-tree drag-and-drop reimplemented on top of plain mouse events (HTML5 DnD is unreliable inside button-rich rows).
- Group field in the connection dialog switched from `<datalist>` to a Select + "new group…" sentinel for WKWebView reliability.

### Security
- CSP enabled in `tauri.conf.json` (previously `null`).

### Fixed
- Several silent `.catch(() => [])` paths in `TableDataView` / `DesignerView` now surface errors via the toast system.

## [0.1.0] — initial preview

First buildable snapshot. Four drivers (SQLite / Postgres / MySQL / Redis), SQL editor, table designer, ER diagram, virtualized data grid, CSV import/export, bilingual UI.
