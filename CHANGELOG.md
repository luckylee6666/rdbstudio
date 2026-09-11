# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- SQLite 整库恢复：可将 `VACUUM INTO` 导出的数据库文件替换回连接文件（校验 SQLite 文件头、连接使用中拒绝恢复、同目录临时文件原子替换）；PostgreSQL / MySQL 的 dump 与 restore 现在可取消。
- 可视化 EXPLAIN 支持 MySQL（`EXPLAIN FORMAT=JSON`，含 nested_loop / ordering / grouping / union 等结构）；PostgreSQL 新增 EXPLAIN ANALYZE（展示实际耗时 / 行数 / 循环数；写语句需二次确认）。
- Redis key 管理：右键数据库节点新建 key（string / hash / list / set / zset，可带 TTL）、重命名 key（目标已存在时拒绝）、点击 TTL 修改或持久化、在 hash / set / zset 视图中删除单个成员。
- 删除连接增加二次确认，并提示系统钥匙串中的密码会一并移除。

### Fixed
- PostgreSQL 的 DATE / TIME / NUMERIC / 数组列、MySQL 的 DATE / TIME / TIMESTAMP / DECIMAL 列不再显示为 NULL：各类型改用自己的解码器，`numeric` / `decimal` 以精确字符串传输。
- PostgreSQL 网格编辑与 CSV 导入按目标列类型显式 `CAST` 绑定，修复所有非文本列报 `42804 … is of type … but expression is of type text` 的问题。
- MySQL `contains` / `starts_with` / `ends_with` 过滤不再因 `ESCAPE '\'` 触发 1064 语法错误；PostgreSQL 文本列与数字值比较不再报 `operator does not exist: text > double precision`。
- SQLite 自管理事务脚本失败后，连接归还连接池前执行 `ROLLBACK`，后续语句不再落入未结束的幽灵事务（曾表现为 `cannot start a transaction within a transaction`、写入被静默回滚）。
- PostgreSQL / SQLite 超出 JavaScript 安全整数范围的整数改以字符串传输，避免网格显示与回写主键时被舍入。
- PostgreSQL Show DDL / 导出补齐 `serial` 序列、数组类型输出为 `text[]`（原为不可执行的 `_text`），视图输出 `CREATE VIEW` 而不是合成的 `CREATE TABLE`。
- 恢复表右键菜单的「导入 CSV」入口（此前 UI 入口被移除但后端、文档和测试仍在），并修复导出 / 导入的「制表符」选项发送字面 `\t` 的问题。
- 命令面板（⌘K）在弹窗打开时不再叠加，避免一次 Escape 同时关闭命令面板和对话框。
- 网格数据应用（Apply）期间禁止继续编辑 / 新增 / 撤销，避免刷新时静默丢弃新改动。
- 连接列表加载失败时显示错误与重试入口，不再永久停留在骨架屏；查询历史的加载与清空失败会给出提示。
- 中文输入法组合状态下按回车不再提前提交（单元格编辑、重命名、过滤条件、Redis 值编辑）。
- 行悬停的撤销 / 删除按钮恢复可见；已打开的标签页再次请求时合并新的预置过滤条件（FK 跳转不会失效）。
- 导出复合主键表时按全部主键列排序，避免 LIMIT/OFFSET 分页在并列值上丢行 / 重行。
- dump / restore 错误摘要截断不再因多字节字符 panic；查询取消句柄在任务启动前注册，消除取消 / 重复 id 的竞态。
- PostgreSQL Show DDL 进一步补全：`GENERATED … AS IDENTITY` 列、命名 CHECK 约束、表与列注释、search_path 之外的枚举类型 schema 限定。
- 虚拟化数据网格 / Redis 表格滚动导致正在编辑的单元格被卸载时，草稿改为自动提交，不再静默丢失。

## [0.1.5] — 2026-09-03

### Fixed
- MySQL 查询编辑器改用文本协议发送语句，`PREPARE` / `EXECUTE` / `DEALLOCATE PREPARE`、`USE`、`LOCK TABLES` 等语句不再报 `1295 (HY000): This command is not supported in the prepared statement protocol yet`，条件建表/加列脚本可以正常执行。
- MySQL 脚本中途失败时不再一律提示「已整体回滚」：MySQL 的 DDL 会隐式提交，后端按实际执行过的语句判断回滚是否完整，遇到 DDL 或 `EXECUTE` / `CALL` 这类运行期才确定的语句会明确提示结构变更已经生效、需要人工核对。SQLite 和 PostgreSQL 的 DDL 仍在事务内，提示不变。
- 编辑器里自己写 `BEGIN` / `COMMIT` / `ROLLBACK` 的脚本现在整批在同一条连接上执行。此前逐条语句各自从连接池取连接，`INSERT` 可能落在与 `BEGIN` 不同的连接上被立即提交，用户的 `ROLLBACK` 实际什么都没撤销；执行 `BEGIN` 的连接还会带着未结束的事务回到池里。这类批次结束后连接不再复用，避免 `USE`、`SET`、临时表、预处理语句名泄漏到其他查询。
- Redis 编辑器按行执行命令。此前整个缓冲区被当成一条命令下发，`parse_args` 把换行当普通分隔符，`PING` + `PING` 会变成 `PING PING` 并静默返回 `PING`；后端现在也拒绝单次调用里出现多条命令。
- 空结果集不再丢失列名：`SELECT ... WHERE 1 = 0` 会通过语句描述补齐表头，四种驱动一致。
- 修复 MCP 桥的 MySQL 只读查询全部失败（`1295 … prepared statement protocol`）：只读保护语句 `START TRANSACTION READ ONLY` 之前走了预处理协议，MySQL 不支持，导致 0.1.4 起经 MCP 查询 MySQL 必然报错。

### Security
- 只读连接在执行前额外校验单条语句，防止 `SELECT 1; DELETE FROM t` 这类多语句输入借文本协议绕过只读判定。
- 只读连接改由数据库原生只读模式强制保护（SQLite `PRAGMA query_only`、PostgreSQL `BEGIN READ ONLY`、MySQL `START TRANSACTION READ ONLY`），不再只依赖语句关键字分类，`SELECT` 调用有副作用的函数或 `nextval()` 也会被数据库拒绝。Redis 只读连接仍由命令白名单把关，并对多行输入 fail closed。

## [0.1.4] — 2026-08-21

### Added
- 新增本机 MCP 桥接服务，可为指定连接创建 60 分钟临时授权，并将配置复制到 AI 对话或 MCP 客户端；支持查看连接元数据、表结构、DDL 和执行受控只读查询，不暴露数据库密码或 SSH 凭据。
- 支持导入 Navicat `.ncx` 连接配置，兼容 SQLite、PostgreSQL、MySQL 和 Redis；导入时不读取或落盘 Navicat 密码，并明确提示需要重新填写凭据。
- 新增整库导出和单表导出入口，可按数据库类型导出结构与数据或仅导出结构。

### Changed
- 连接侧栏支持拖动调整宽度，连接分组拖放增加跟随指针的可视反馈，长连接名和表名更容易查看。
- 统一 SQLite、PostgreSQL、MySQL 和 Redis 的连接弹窗布局与测试状态展示，改善窄窗口和长提示文本下的排版。
- GitHub Tag 打包生成的 Release 默认直接公开，稳定版不再停留在 Draft。

### Fixed
- 修复部分连接和表右键菜单操作点击无响应，以及弹窗 Portal 事件冒泡导致父级误触发的问题。
- 修复导入导出任务运行时仍可被 Escape、遮罩或关闭按钮隐藏的问题，并补充表导出、整库导出和上下文菜单回归测试。
- 修复列宽拖动、侧栏缩放和菜单延迟监听在窗口失焦或组件卸载后可能残留的问题。

### Security
- MCP 的 SQLite、PostgreSQL 和 MySQL 查询改由数据库原生只读模式强制保护，阻止 `SELECT` 调用有副作用的存储函数绕过只读限制。
- Redis MCP 使用独立的严格命令白名单，禁止 `CONFIG GET`、`CLIENT LIST`、`INFO`、`KEYS`、`DUMP` 等敏感或高负载命令。
- MCP 授权在连接编辑、删除、重新授权、服务停止或到期时立即撤销并取消在途调用；增加协议版本校验、请求超时、连接并发、结果行数和响应字节限制。

## [0.1.3] — 2026-08-20

### Fixed
- MySQL 无符号整数（包括 `BIGINT UNSIGNED`）不再被错误显示为 `NULL`；超出 JavaScript 安全整数范围的值以精确字符串传输和编辑，避免主键被舍入。
- 旧连接未保存 TLS 选项时继续沿用驱动原有的自动协商行为，新连接和显式“禁用”配置才强制明文，避免升级后连接要求 TLS 的数据库失败。
- SSH 隧道与 `verify-full` 组合现在会明确拒绝并提示改用显式策略，不再静默降低证书和主机名校验强度；导出和恢复路径保持一致。
- 连接配置与系统钥匙串改为可回滚保存，钥匙串或配置文件写入失败时不会留下部分更新；配置内存状态与磁盘保持一致。
- 嵌套弹窗按 Escape 只关闭最上层弹窗，并补充焦点约束与关闭后的焦点恢复。

### Changed
- 重整连接弹窗布局，改善窄窗口适配、只读设置、环境标记和基础无障碍属性。
- tag 打包工作流新增前端测试与 tag、应用版本、Changelog 一致性校验。

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
