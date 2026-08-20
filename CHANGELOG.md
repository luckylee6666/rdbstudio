# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.2] — 2026-08-20

### Changed
- 连接配置、查询历史和代码片段改存于用户主目录 `~/.rdbstudio/`，首次启动时会从旧的系统应用数据目录安全复制；已有目标文件不会被覆盖，旧文件不会被删除。

## [0.1.1] — 2026-08-20

### Fixed
- 标签页切换时隔离表格编辑状态、筛选条件与 SQL 草稿，避免跨表误提交和查询内容串用。
- CSV 导入正确忽略未映射列，并拒绝重复目标列映射。
- MySQL “清空后导入”改用可回滚的事务内删除，避免导入失败后原数据无法恢复。
- 收紧只读 SQL 与 Redis 命令校验，限制分页、导出批次和 Redis 扫描数量，避免异常输入带来的越权写入或资源耗尽。
- 拒绝重复查询 ID，修复查询状态互相覆盖的问题。

### Changed
- 移除未使用的 Tauri Shell 权限与 Rust 插件依赖，缩小桌面端权限范围。

## [0.1.0] — 2026-07-20

First stable release: macOS (Apple Silicon) `.dmg` and Windows x64 `.msi`/`.exe` installers.

### Added
- **Whole-database dump & restore** — SQLite `VACUUM INTO`, PostgreSQL `pg_dump`/`psql`, MySQL `mysqldump`/`mysql`; client binaries auto-discovered (Homebrew prefixes on macOS, versioned Program Files dirs on Windows), passwords passed via environment, SSH-tunneled connections use the tunnel's local forward.
- **Visual EXPLAIN** — PostgreSQL `EXPLAIN (FORMAT JSON)` and SQLite `EXPLAIN QUERY PLAN` rendered as an auto-laid-out plan graph; hotspots highlighted by self cost.
- **Atomic multi-statement execution** — editor scripts run inside one backend transaction and roll back entirely on failure (scripts managing their own BEGIN/COMMIT keep per-statement behavior).
- **Read-only connections** — server-side gate across every write path, including data-modifying CTEs and a Redis command whitelist.
- Connection environment color tags; per-connection SSH tunnels (key / agent / password on Unix) and SSL/TLS verification modes.
- Table operations: rename, truncate, duplicate structure; create table / schema dialogs; drop table / view / Redis key with confirmation.
- Data grid: FK value jump, copy row as INSERT / CSV / JSON, query-result export (CSV / JSON / SQL).
- Redis editing: in-place value edits; hash/set/zset renames via guarded atomic Lua scripts.
- Query cancellation, 10k-row result cap with truncation banner, query history, SQL snippets, favorites panel.
- Workspace persistence across restarts (tabs + editor buffers), tab context menu (close others / right / all), middle-click close, sidebar tree filter.
- Windows x64 support (platform-specific binary discovery, shortcut labels, title-bar layout) and bilingual (en-US / zh-CN) MSI installers.
- Global keyboard shortcuts: ⌘T / ⌘W / ⌘B / ⌘/ / ⌘⇧F (Ctrl on Windows); macOS default-menu ⌘W conflict resolved.
- Global toast notifications, top-level error boundary, keyboard-shortcut reference in Settings.
- Connection groups with drag-and-drop; dedicated Redis type-aware key viewer with TTL and paginated SCAN.

### Changed
- CSV import batches hundreds of rows per multi-row INSERT with savepoint replay for precise per-row errors (also stops one bad row from aborting a whole PostgreSQL import).
- Full i18n sweep — UI is fully bilingual (中文 / English), including error messages and tooltips.
- CSV export routed through the dialog plugin + Rust file writer; clipboard via `tauri-plugin-clipboard-manager`; native `prompt`/`confirm` replaced with in-app dialogs (all WKWebView-blocked APIs).
- Connection-tree drag-and-drop reimplemented on plain mouse events (HTML5 DnD is unreliable in WKWebView).

### Fixed
- PostgreSQL `RETURNING` rows no longer dropped; leading comments/parens no longer misclassify reads as writes.
- Editing a row in a table without a primary key aborts when it would match multiple rows.
- Corrupt config/history stores are quarantined to `*.json.corrupt` instead of being silently reset.
- Unbounded `SELECT` results no longer freeze the UI; SSH temp files no longer leak on failed tunnel spawns.

### Security
- CSP enabled in `tauri.conf.json`; passwords live in the system keychain, never in config files or command lines.

## [0.1.0-rc.1 / rc.2] — early previews

Initial buildable snapshots: four drivers (SQLite / Postgres / MySQL / Redis), SQL editor, table designer, ER diagram, virtualized data grid, CSV import/export, bilingual UI.
