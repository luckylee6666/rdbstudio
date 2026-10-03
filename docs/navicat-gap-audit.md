# Navicat 功能对照与缺陷审查（2026-10-03）

基线：本地提交 `e6dbc9e`，应用版本 0.1.6。Claude 项目记忆最后记录为 0.1.5，因此本报告以当前源码、CHANGELOG 和测试为准。此次审查分为正确性与回归、安全与性能、前端与测试三路，随后复核和修复；不是对所有数据库版本与操作系统的完整认证。

## 功能差距

外部对照：[Navicat Premium 官方功能矩阵](https://www.navicat.com/en/products/navicat-premium-feature-matrix)。以下优先级按本项目的单机数据库工作台定位建议，不代表本轮承诺实现全部功能。

| 优先级 | 能力 | 当前实现与差距 | 代码入口 |
|---|---|---|---|
| 高 | 查询会话与手动事务 | 单次脚本共享连接；不同次运行仍从池取连接，`SET`、临时表、分次 BEGIN/COMMIT 没有 tab 级会话保证。需要连接生命周期、取消与断线恢复设计。 | `commands/query.rs`、`db/exec.rs` |
| 高 | 多结果集与结果保留 | 脚本返回最后一条结果和汇总；没有每条 SELECT 的结果页签、结果固定及对照。 | `QueryEditorView.tsx`、`ScriptOutcome` |
| 高 | 结构比较、数据同步与跨库传输 | 有表设计、DDL、导入导出；没有源/目标差异预览、冲突处理和同步执行流程。 | `DesignerView.tsx`、`db/alter.rs`、`db/io.rs` |
| 中 | 对象管理 | 侧栏主要列出表/视图；列可编辑，索引与外键主要展示。函数、存储过程、触发器、用户/权限缺少专用管理界面，可手写 SQL。 | `ConnectionTree.tsx`、`DesignerView.tsx`、`db/meta.rs` |
| 中 | 数据编辑 | 有虚拟网格、筛选排序、FK 跳转、JSON 查看；缺表单编辑、专用二进制/图片编辑和数据库全局数据搜索。 | `TableDataGrid.tsx`、`DataGrid.tsx` |
| 中 | 导入格式 | CSV 导入已实现；JSON/SQL 导出已有。尚无 XLSX、XML、ODBC 等多源导入流程。 | `ImportDialog.tsx`、`db/io.rs` |
| 中 | Redis 大数据与高级工具 | 有 key CRUD、TTL、成员编辑和 SCAN；hash/set 浏览仍使用 HGETALL/SMEMBERS，需进一步改成增量扫描。Pub/Sub、Cluster、Streams 管理仍有限。 | `RedisKeyView.tsx`、`db/redis_ops.rs` |
| 中 | 交付体验 | 仍需正式签名、公证及自动更新；Windows 真实交互需要单独验收。 | 发布工作流、Tauri 配置 |

SQL 格式化、列级补全、查询取消、SQL 结果行数上限、CSV/JSON/SQL 导出、备份恢复、ER 图、MySQL 可视化 EXPLAIN、PostgreSQL EXPLAIN ANALYZE 已有实现，不再作为“缺失功能”列出。

项目记忆明确暂不做云协作、定时任务、可视化查询构建器和存储过程调试器。这些是与 Navicat 的产品范围差异，不是本轮 bug。

## 本轮修复与回归场景

| 问题 | 触发与影响 | 修复 |
|---|---|---|
| SQLite 导出覆盖源库 | 保存路径选中正在导出的数据库；结构导出直接写入 SQL，数据导出先删除源文件。 | 拒绝源库、路径别名和日志文件；先生成临时备份，完整成功后替换。 |
| SQLite 导出失败丢失旧备份 | 原备份先删除，随后 VACUUM 失败。 | 临时文件暂存，失败保留旧备份并清理临时文件。 |
| SQLite 恢复接受损坏备份 | 文件保留 16 字节 magic，但内容被截断或损坏，也会覆盖好库。 | 暂存后只读打开并执行 quick_check，校验通过才替换；使用跨平台安全文件替换。 |
| SQLite 恢复未检查其他连接 | 目标连接已断开，但另一条连接仍打开相同文件或路径别名。 | 扫描所有活动池的实际文件并拒绝覆盖；恢复与连接生命周期操作互斥。保护范围为本应用内连接，外部程序仍应关闭数据库后再恢复。 |
| 带注释的事务控制误判 | BEGIN/ROLLBACK 前有注释时，被错误包进软件管理的事务。 | 分类前剥离前导注释，保留脚本自管事务语义。 |
| Redis Escape 取消仍提交 | 单元格取消导致卸载，卸载清理把草稿发送给后端。 | 取消先标记草稿已处理，保留滚动卸载时正常保存行为。 |
| Redis string 编辑清除 TTL | 普通 SET 将临时 key 变成永久 key。 | 使用 SET KEEPTTL 保留服务端实时 TTL，不用读到的旧 TTL 重新续期。 |
| Redis 结果无 IPC 上限 | 大集合或大字符串转换后全部传给界面。 | 10,000 行及 8 MiB 序列化行数据预算；显示截断，禁止编辑不完整字符串。 |

Redis `KEEPTTL` 自 Redis 6.0 起支持，见 [Redis SET 文档](https://redis.io/docs/latest/commands/set/)。旧版服务器会返回不支持的命令错误，不会回退到丢 TTL 的 SET。

## 验证边界

本轮最终检查：`pnpm test` 26 个文件、152 项通过；`pnpm build` 通过；`cargo test --locked -- --nocapture` 报告 220 项通过，其中 20 项数据库用例因环境变量缺失提前返回；`cargo clippy --locked --all-targets -- -D warnings` 与 `git diff --check` 通过。新增测试覆盖取消后的卸载、TTL 保存命令、带注释的事务控制、结果预算边界、SQLite 导出失败保护、损坏备份拒绝、文件别名与连接并发。

SQLite 回归使用临时文件/内存数据库；前端回归使用组件测试与 IPC mock。当前环境没有配置数据库集成测试环境变量，且沙箱拒绝本机 TCP 连接，因此 MySQL、PostgreSQL、Redis 的 env 门控用例本轮未实跑，不能把它们的提前返回计为真机验证。桌面壳与 Windows UI 未在本轮手动验收。

Redis 驱动仍会先读取完整响应，新增限制保护转换后的结果与 IPC，不能保证驱动阶段的峰值内存。Redis list 按索引编辑仍缺并发冲突检测；这些需要后续改为分页读取与服务端条件更新。
