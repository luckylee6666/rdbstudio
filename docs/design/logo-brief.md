# rdbstudio Logo 重设计需求

> 用途：交给设计 AI（Codex / Claude / Midjourney 等）作为 self-contained 设计简报。
> 读这份文档应当能完成全部交付物，不需要追问。

## 项目背景

**rdbstudio** 是一款现代化的跨平台数据库 GUI（Tauri + React + Rust 桌面应用），定位对标 Navicat / DBeaver / TablePlus。一个客户端连接四种主流数据库：

- **SQLite**（本地文件库）
- **PostgreSQL**（关系型 OLTP）
- **MySQL**（关系型 OLTP）
- **Redis**（KV / 缓存 / 数据结构）

目标用户：后端 / 数据工程师 / DBA / 全栈开发者。日常场景：连数据库、跑 SQL、看表、调 Redis key、做轻量数据探索。

仓库：https://github.com/luckylee6666/rdbstudio
协议：MIT

## 当前 logo 的问题（请避免重蹈覆辙）

现有图标位于 `src-tauri/icons/icon.png`，是"蓝色圆角方形 + 居中白色圆柱体"，问题：

1. **撞型严重**——Navicat、DBeaver、Postico、Beekeeper Studio、TablePlus 全都在用"数据库圆柱"母题，扔在 Dock 里完全分不出来
2. **没有品牌记忆点**——任何数据库工具都能套这个图
3. **视觉太"教科书"**——白色圆柱 + 椭圆顶面是 90 年代 ER 图教学符号，过时
4. **没有体现"多数据库统一"这个核心卖点**

## 设计目标

做一个让人 **一眼记住 rdbstudio**、扔在 Dock / 任务栏里能从其他数据库工具中跳出来的图标。可以保留"数据库 / 数据"的暗示，但**不要再用经典圆柱体**。

## 设计方向（3 个方向，自由发挥或混搭，不要全做）

### 方向 A：抽象字母构形（推荐）

以 **"r"** 或 **"R"** 为主体做几何抽象。例如：

- "r" 的圆弧部分变成一道连接线 / 数据流
- 字母嵌入一个被切分的方块中，暗示"表 / 结构 / schema"
- 类似 Linear、Vercel、Raycast 那种"字母即标志"的克制风格

### 方向 B：数据流 / 连接母题

不画存储容器，画**连接关系本身**——

- 多条线汇聚到一个节点（暗示"一个客户端连多种数据库"）
- 或者两个 / 四个几何元素（对应 SQLite/PG/MySQL/Redis）被一根线 / 一个圆环统一
- 参考：Supabase 的闪电、Prisma 的三角形棱镜、Neon 的电弧

### 方向 C：终端 / 命令光标

- 一个发光的方块光标 `▮` 嵌在 schema 网格里
- 或者 SQL 提示符 `>_` 的几何抽象
- 强调"专业工具 / 命令行原生用户也用得爽"

**不要做的方向**：圆柱体、3D 服务器机架、磁盘、文件夹、放大镜、齿轮、emoji 风格的拟物图标。

## 视觉风格约束

| 项目 | 要求 |
|---|---|
| **整体调性** | 现代、克制、专业。参考标杆：Linear / Raycast / Vercel / Arc Browser / Cursor 的 app icon |
| **主色** | 蓝灰系（cool blue / slate）。可用渐变，但**避免**饱和度过高的纯蓝、避免迪士尼式糖果色 |
| **辅色** | 最多 1 个强调色（建议青绿 `#2dd4bf` 或暖琥珀 `#f59e0b` 中选一个，用来点睛） |
| **形状语言** | 几何精确、栅格对齐、不要手绘感、不要拟物高光 |
| **背景** | macOS 风格圆角方形（**squircle**，超椭圆而不是普通 `border-radius`），半径符合 Big Sur 之后的 app icon 模板 |
| **底色处理** | 可用细微渐变 / 暗角，但**不要**强反光 / 玻璃拟物 / 长投影 |
| **禁用元素** | emoji 风格、卡通、贴纸感、霓虹 outline、AI 通用的"紫粉渐变 + 球体"模板 |

## 技术交付物

主稿用 **SVG** 设计（矢量），然后导出以下光栅版本，**全部放进 `src-tauri/icons/`**（覆盖现有同名文件）：

```
src-tauri/icons/
├── icon.svg              # 主稿（1024×1024 viewBox）— 新增
├── icon.png              # 512×512  （Tauri 主图标）— 覆盖
├── 128x128.png           # 128×128                    — 覆盖
├── 128x128@2x.png        # 256×256                    — 覆盖
├── 32x32.png             # 32×32（小尺寸必须可识别！）— 覆盖
├── icon.icns             # macOS（含 16/32/64/128/256/512/1024）— 覆盖
└── icon.ico              # Windows（含 16/32/48/256）            — 覆盖
```

### 关键技术要求

1. **16×16 / 32×32 必须可读**——logo 在任务栏 / Dock 缩到最小时不能糊成一坨。设计时同步检查小尺寸渲染
2. **macOS squircle 模板**——背景遵循 Apple 的 `1024×1024` icon 模板（圆角半径约 185px，且是 squircle 不是简单圆角矩形）
3. **不要内置阴影**——macOS 会自动给 app icon 加投影，自带阴影会重叠出脏边
4. **安全区**——主体元素不要贴边，留约 10% padding（1024 画布约 100px）
5. **深 / 浅背景都要测试**——在 macOS 浅色和深色 Dock 上、Windows 浅 / 深主题任务栏上都要清晰

### 文件名大小写

注意：项目名是 **rdbstudio**（lowercase r d b studio），**不是** RDBStudio 或 RdbStudio。如果 logo 包含文字，请用小写。

## 评估标准 & 交稿格式

请同时输出 **三种预览** 方便选稿：

1. 单独 1024×1024 主稿（透明背景 + 白底两版）
2. macOS Dock 中和其他 app icon（Finder、VSCode、Terminal、Chrome）并排的合成图
3. 32×32 小尺寸放大渲染（验证小尺寸可读性）

最终成品要满足：

- [ ] 一眼能看出和 Navicat / DBeaver 等竞品不同
- [ ] 32×32 下仍可识别
- [ ] 没用圆柱体 / 服务器 / 文件夹这类陈词滥调
- [ ] 蓝灰中性调，最多 1 个强调色
- [ ] 是 squircle 不是普通圆角矩形

## 导出工具提示（可选参考）

- **SVG → PNG / ICNS / ICO** 推荐链路：
  - SVG 主稿用 Figma / Illustrator / 手写
  - PNG 多尺寸：`rsvg-convert` 或 Figma export
  - `.icns`：`iconutil -c icns icon.iconset/`（先做 `.iconset` 目录）
  - `.ico`：ImageMagick `magick convert icon-16.png icon-32.png icon-48.png icon-256.png icon.ico`

不强制用哪条链路，文件齐了就行。
