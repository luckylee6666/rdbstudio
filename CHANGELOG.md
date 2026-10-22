# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-10-22

### Added
- 导出列数据脱敏（Data Masking）：单表导出（CSV / JSON / SQL INSERT）支持按列配置 `email`、`phone`、`name`、`partial`、`redact`、`hash`、`null` 7 种脱敏规则，并提供敏感列名智能识别。
- 测试数据生成器（Test Data Generator）：表右键支持按列配置 14 类生成规则（自增序列、随机整数/浮点数、布尔、UUID v4、姓名、邮箱、手机号、随机词组、枚举列表、日期、时间戳等）与空值比例，内置种子复现预览与事务内批量写入。
- 视图可视化设计器与 ER 图增强：数据库/Schema 右键新增「新建视图…」与视图节点「设计视图」（含实时 `SELECT` 预览、跨 SQLite/PG/MySQL 保存与改名）；ER 关系图支持节点位置本地持久化、重置布局与导出独立矢量 `.svg`。
- 服务器实时监控与进程列表（Server Monitor）：新增监控工具页，支持查看 PostgreSQL `pg_stat_activity`、MySQL `PROCESSLIST`、Redis `INFO`/`CLIENT LIST` 与 SQLite `PRAGMA` 统计指标，并提供只读守卫下的取消查询 / 终止会话操作。
- 同连接表复制新增默认的数据库原生模式：SQLite/PostgreSQL 在事务内复制，MySQL 使用独立暂存表并原子改名发布；支持无主键、重复行和超过 10,000 行/16 MiB 的表，行数据不经 JSON 传回应用。预览显示 SQL 与遗漏对象，执行前重查结构，提供阶段/耗时进度和提交前取消；原有主键及数据量受限的可移植模式继续保留。
- MySQL 事件管理表单：单次/周期计划、事件体与备注、新建默认禁用、独立启停和确认删除；原地修改保留定义者、时区及 SQL 模式，不修改全局调度器。
- PostgreSQL 序列管理表单：类型、范围、步长、缓存与循环；全部整数以字符串传输。普通保存保留当前取号值，显式重启需确认，删除保留依赖保护；对象树可直接打开对应事件或序列管理页。
- Redis key 按冒号命名空间分组，保留完整名称、类型、TTL 与过滤；hash/set/list/zset 成员新增及删除入口，列表删除使用索引与旧值校验并保留 TTL，空字符串 key 也能正常打开。
- 表右键增加维护和结构/数据复制预览：PostgreSQL ANALYZE/VACUUM ANALYZE、MySQL ANALYZE/OPTIMIZE、SQLite ANALYZE/全库 VACUUM；复制支持同连接新表、显式显示不复制的对象，可移植模式复用有界同步引擎。
- 连接树按需浏览函数、过程、触发器、MySQL 事件与 PostgreSQL 序列；保留 PG 重载签名，点击读取定义，不执行对象；目录最多 500 项并提示截断。
- 连接菜单和查询工具栏增加打开 SQL 文件，查询工具栏支持保存 SQL 文件。打开文件会新建查询页，不覆盖当前草稿或自动执行；UTF-8 文件上限 8 MiB，大型数据库转储继续使用整库恢复。
- 浏览器开发桥接可使用隔离数据目录调用真实后端，便于数据库功能验收；详见 `docs/web-bridge.md`。
- SQL 查询标签页独立会话、事务控制与关闭/取消确认；多语句结果页签、结果固定与并排对照。
- 索引与复合外键可视化新建/替换/删除、MySQL 索引前缀长度、SQLite 无损表重建保护；数据库函数/过程/触发器及用户权限管理页面。
- 有界结构比较、数据同步与跨库传输预览，追加/覆盖/镜像策略、并发旧值守卫；标准自增/identity 传输与 PostgreSQL 目标序列对齐；全库字面搜索与主键跳转。
- JSON/XML/Excel 工作表导入、字段映射与原子回滚；表单、十六进制及二进制文件编辑/导出、图片预览。
- Redis hash/set 分页、list CAS、Streams 条目与消费组工具、独立 Pub/Sub 生命周期和 Cluster 状态/节点页面。
- 备份恢复字节/阶段/耗时进度；更新检查、下载进度、安装与重启入口；签名/公证和签名更新产物的 CI 接入及缺项校验（证书与发布 Secrets 仍需配置）。

### Fixed
- SQLite 连接及连接测试不再读取未使用的数据库密码，修复无系统钥匙串服务的 Linux 环境连接失败和 CI 报错；其他数据库及独立 SSH 凭据仍保留原有读取与错误处理。
- 弹窗正确设置初始焦点，Tab/Shift+Tab 不再逃逸到底层界面；嵌套关闭恢复可用的上层入口，旧弹窗不抢占新弹窗焦点，已处理的 Escape 和输入法组合键不会误关弹窗。默认关闭标签随语言切换，窄窗口页脚按钮可换行。
- 表单编辑按工作区实际宽度堆叠字段，二进制编辑精确限制到 8 MiB，读取文件期间切为只读不会继续提交；计算二进制长度不再构建去空白的完整副本。
- 表设计器对象目录由后端按当前表筛选触发器，不再读取整个 schema 的例程和用户权限；MySQL 使用精确名称匹配，避免目录排序规则混入大小写不同的对象。
- 表复制/同步在异步重预览后再次核对连接与只读状态，创建目标后的预览复用同一组连接，避免重连期间把旧授权用于新数据库；若结构已经创建，会在拒绝数据写入时明确提示。
- 对象管理器以 schema、表和完整重载签名识别对象，修复刷新后误选同名 PostgreSQL 函数的问题；新对象表单保持所选数据库范围，保留既有对象的完整名称。
- 表复制/同步的多页读取固定在同一只读事务快照中，修复并发删除导致 OFFSET 分页漏行的问题；MySQL 非事务源表明确拒绝数据同步，保留结构预览。
- 表与数据库对象节点支持 Enter/空格打开；右键菜单支持方向键、Home/End、Enter/空格与焦点恢复，Escape 优先关闭菜单，长菜单可滚动且不再超出窗口。
- PostgreSQL/SQLite 对象定义在数据库端先检查字节长度，超过 1 MiB 时不传回完整定义；最终输出大小校验继续保留。
- 浏览器测试启动器先检查端口并等待后端就绪，避免前端先启动而桥接失败；退出时清理所属子进程树，避免遗留测试服务。
- PostgreSQL/MySQL 导出先写同目录暂存文件，成功且非空后才替换目标；错误、取消或空输出保留旧备份。整库导出对话框支持停止任务并等待后端结束。
- MySQL 备份包含事件调度器对象，以十六进制保存二进制数据，并关闭 GTID_PURGED 输出，修复同服务器恢复因 GTID 重叠失败的问题；这些备份用于数据恢复，不用于初始化复制拓扑。
- WebView 重载时恢复后端活动连接的状态及服务器版本，保存/连接/删除期间的过期响应不再覆盖新状态；断开或切换连接目标后清除旧版本信息。
- SQLite 导出禁止覆盖正在导出的数据库及日志文件，改为先生成临时备份、成功后替换，避免导出失败丢失旧备份。
- SQLite 恢复在替换前校验完整性，拒绝只有正确文件头但内容损坏的备份；文件替换不再先删除 Windows 上的原库。
- SQLite 恢复检查所有活动连接使用的实际文件（含路径别名），并与连接生命周期操作互斥，避免另一条连接仍在使用同一文件时被覆盖。
- SQL 脚本的事务控制语句前有注释时，仍能正确识别为自管理事务，避免重复开启事务。
- Redis 单元格按 Escape 取消后不再由卸载清理逻辑误提交；编辑 string 值使用 KEEPTTL 保留现有过期时间（Redis 6.0+）。
- Redis 查询结果增加 10,000 行与 8 MiB 序列化行数据上限，显示截断提示并禁止编辑不完整的字符串值。限制作用于转换后的结果与 IPC，驱动仍会先读取完整服务端响应。

## [0.1.6] — 2026-09-11

### Added
- SQLite 整库恢复：可将 `VACUUM INTO` 导出的数据库文件替换回连接文件（校验 SQLite 文件头、连接使用中拒绝恢复、同目录临时文件原子替换）；PostgreSQL / MySQL 的 dump 与 restore 现在可取消。
- 可视化 EXPLAIN 支持 MySQL（`EXPLAIN FORMAT=JSON`，含 nested_loop / ordering / grouping / union 等结构）；PostgreSQL 新增 EXPLAIN ANALYZE（展示实际耗时 / 行数 / 循环数；写语句需二次确认）。
- Redis key 管理：右键数据库节点新建 key（string / hash / list / set / zset，可带 TTL）、重命名 key（目标已存在时拒绝）、点击 TTL 修改或持久化、在 hash / set / zset 视图中删除单个成员。
- Redis 的 Keys 文件夹也可右键新建 key；删除 key 改走专用命令，与其它 Redis 写操作共用只读连接限制。
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
- ER 图在大 schema（超过 80 张表）下显示「仅显示前 N 张，共 M 张」的截断提示，不再静默丢表。

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
