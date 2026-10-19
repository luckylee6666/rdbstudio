<p align="center">
  <img src="src-tauri/icons/icon.png" width="160" height="160" alt="rdbstudio" />
</p>

<h1 align="center">rdbstudio</h1>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-2.0-blueviolet?logo=tauri" alt="Tauri" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-18-61dafb?logo=react" alt="React" /></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-1.88+-dea584?logo=rust" alt="Rust" /></a>
</p>

<p align="center"><strong>现代化跨平台数据库 GUI</strong> — 面向 SQLite、PostgreSQL、MySQL 和 Redis 的 Navicat 风格工作台，基于 Tauri 2 + React + sqlx。</p>

> 状态：**v0.1.0** — 首个稳定版。macOS（Apple Silicon）和 Windows x64 安装包见 [Releases](https://github.com/luckylee6666/rdbstudio/releases)。

## 功能

**查询与分析**
- SQL 编辑器（CodeMirror 6）：列感知补全、SQL 格式化、片段库
- 多语句脚本在**同一事务中原子执行** — 任一条失败整段回滚，并标出出错语句
- 查询可中途取消；结果上限 1 万行，超出有明确截断提示（避免 `SELECT *` 把界面卡死）
- **可视化 EXPLAIN**：PostgreSQL / SQLite 执行计划自动排成节点图，按 *self* cost 标出热点
- 查询历史可重跑；结果可导出为 CSV / JSON / SQL INSERT

**数据与结构**
- 虚拟化数据网格：行内编辑（命中多行时服务端拒绝写入）、外键跳转、复制行为 INSERT / CSV / JSON、JSON 单元格预览
- 表设计器带实时 DDL 预览；建表 / 建 schema、重命名、清空、复制表结构
- ER 图自动布局
- CSV 导入（批量多行 INSERT，按行报错）和表导出
- **整库备份与恢复**：SQLite 用 `VACUUM INTO`，PostgreSQL 用 `pg_dump`/`psql`，MySQL 用 `mysqldump`/`mysql` — 自动探测客户端，密码不进命令行。导出失败或取消时保留旧备份；MySQL 包含函数/过程及事件、以十六进制保存二进制值，并省略全局 GTID 状态，适用于普通数据恢复，不用于初始化复制拓扑。

**Redis**
- 按类型查看 key（string / hash / list / set / zset / stream / JSON），带 TTL、分页 SCAN
- 值可原地编辑；field / member 重命名走**带守卫的原子 Lua 脚本**（不覆盖、不丢值）

**连接与安全**
- 连接分组（拖拽）、环境色标、收藏置顶
- **只读模式**在所有写路径上由服务端强制执行 — 含会改数据的 CTE
- SSH 隧道（密钥 / agent / 密码¹），SSL/TLS 证书校验模式
- 密码存在系统钥匙串（macOS Keychain / Windows 凭据管理器），不写配置文件
- 损坏的配置 / 历史文件会隔离，不会被静默清空

**工作区**
- 标签页、编辑器内容和布局重启后保留
- 命令面板（打开任意表 / key / 操作），侧栏实时过滤大 schema
- 中英双语界面，深色 / 浅色主题

¹ SSH 密码认证仅 macOS / Linux；Windows 请用密钥文件或 ssh-agent。

## 安装

### 预编译包（未签名）

打 tag 的版本会把安装包发到 [Releases](https://github.com/luckylee6666/rdbstudio/releases)：

- **macOS arm64** — `.dmg`（Apple Silicon）
- **Windows x64** — `.msi`（en-US / zh-CN）或 `.exe` 安装器

目前尚未代码签名，首次打开需要多一步：

- **macOS**：双击提示「Apple 无法验证…」→ 点 **完成** → **系统设置 → 隐私与安全性** → 往下滚 → **仍要打开**。（应用是 ad-hoc 签名，不会出现死胡同的「已损坏」对话框。）
- **Windows**：SmartScreen → **更多信息** → **仍要运行**。Windows 10 可能提示安装 WebView2；Windows 11 自带。

有代码签名证书后会出签名 / 公证版本。

### 从源码构建

需要：
- **Rust** 1.88+（`rustup install stable`）
- **Node** 20+ 和 **pnpm** 10+
- **系统依赖**：见 [Tauri prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone git@github.com:luckylee6666/rdbstudio.git
cd rdbstudio
pnpm install
pnpm tauri dev     # 开发模式
pnpm tauri build   # 正式包在 src-tauri/target/release/bundle/
```

## 快捷键

| 操作 | Mac | Windows / Linux |
|---|---|---|
| 执行查询（或选区） | ⌘↵ | Ctrl+Enter |
| 格式化 SQL | ⌘⇧F | Ctrl+Shift+F |
| 命令面板 | ⌘K | Ctrl+K |
| 新建查询标签 | ⌘T | Ctrl+T |
| 关闭标签 | ⌘W | Ctrl+W |
| 切换侧栏 | ⌘B | Ctrl+B |
| 切换主题 | ⌘/ | Ctrl+/ |
| 编辑器查找（CodeMirror） | ⌘F | Ctrl+F |

完整列表见应用内 **设置 → 快捷键**。

## 开发版新增（Unreleased）

查询标签页独立会话与事务控制、多结果页签及固定对照、索引/外键编辑、对象与用户权限管理、基础结构/数据同步与跨库传输、全库搜索、Excel/JSON/XML 导入、表单与二进制编辑、Redis 分页/Pub/Sub/Streams/Cluster 状态、备份恢复进度，以及应用内更新客户端。

对象工具新增 PostgreSQL 序列参数和 MySQL 事件计划表单：序列整数保持精度，重启需确认；事件默认禁用，另行确认启用。事件表单支持简单周期单位和单条 SQL，复杂逻辑可调用已有存储过程；已有复杂事件体未修改时，可保留原文并调整计划或备注。

表复制默认使用数据库原生模式，在同连接、同 schema 下创建新表，支持无主键、重复行及超过可移植模式 10,000 行 / 16 MiB 上限的数据，行数据无需经 JSON 往返。先预览 SQL 与遗漏对象，再复制执行时的快照；提供阶段、耗时和最终提交或发布前取消。SQLite/PostgreSQL 使用事务，MySQL 仅支持 InnoDB，通过独立暂存表和原子改名发布。各库的外键、触发器、序列和清理权限边界见[原生复制说明](docs/navicat-gap-audit.md#2026-10-18-同连接原生表复制)；原有可移植模式继续保留主键、类型和数据量限制。

入口、支持范围和数据量限制见 [功能对照与实现说明](docs/navicat-gap-audit.md)；发布签名和更新通道的材料要求见 [签名接入说明](docs/release-signing.md)。

## 路线图

- 代码签名 + 公证；自动更新通道
- 更完整的结构迁移（复杂约束、索引、生成列、分区）
- Redis 集群拓扑变更与透明路由
- 大规模同步的流式执行与更完整的进度/取消

详细范围与验证边界见 [Navicat 功能对照与审查](docs/navicat-gap-audit.md)。

## 技术栈

- **前端**：Tauri 2 + React 18 + TypeScript + Vite 6 + Tailwind 3 + Radix UI
- **编辑器**：CodeMirror 6（`@codemirror/lang-sql`）
- **图**：`@xyflow/react` + dagre
- **状态**：Zustand（工作区持久化）
- **后端**：Rust + sqlx 0.8（sqlite / postgres / mysql）+ redis 0.27 + tokio + keyring + csv

## 贡献

1. Fork → 开分支 → 提交 → PR。
2. 推送前跑 `pnpm test`（Vitest）和 `cd src-tauri && cargo test`。
3. 保持 `tsc --noEmit` 干净 — 不要用 `any`，除非注释说明理由。

## 许可证

MIT — 见 [LICENSE](LICENSE)。

与 PremiumSoft / Navicat 无关。"Navicat" 是其权利人的商标；rdbstudio 是受其界面习惯启发的独立开源替代。
