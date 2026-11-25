# 可视化查询

在欢迎页、左侧“查询”面板或命令面板中打开“可视化查询”。当前支持 SQLite、PostgreSQL 和 MySQL。

1. 选择数据库连接，未连接时点击“连接”。PostgreSQL 可选择 Schema，MySQL 可选择数据库。
2. 添加表或视图。可多次添加同一张表进行自连接；每个来源使用独立别名。切换 Schema 后可继续添加同连接下其他 Schema 的表，已有表保留原所属 Schema。
3. 添加输出字段、条件、分组与排序。右侧比较值可选择“值”“字段”“聚合函数”或“SQL 表达式”；连接两个表时，将右侧类型切换为“字段”，选择另一表的字段。嵌套条件组可使用 AND、OR、NOT；IN 的每个值独立输入，包含逗号的文本无需拆分。
4. 检查 SQL 预览，点击“在 SQL 编辑器中打开”。生成过程不执行查询；在编辑器中选择执行后才访问数据，结果、取消和会话管理使用现有编辑器功能。

例如，添加 `customers` 和 `orders`，用 LEFT JOIN 关联 `customers.id = orders.customer_id`；输出客户名称及 `SUM(orders.amount)`，按客户名称分组，在 HAVING 中筛选聚合金额大于 10，然后按金额降序排列。

草稿随标签页保存在本机，切换标签或重启可恢复。关闭标签会移除该设计。更换连接会提示清空设计；如需保留，请另开一个构建器标签。生成的 SQL 编辑器标签保留初始 SQL，之后的编辑优先恢复，不反向修改可视化草稿。

未选择输出字段时使用 `*`。LIMIT 默认为 100，留空表示不设限；MySQL/SQLite 使用非零 OFFSET 时必须填写 LIMIT。MySQL 不支持 FULL JOIN，界面会禁用该选项。移除表后，相关字段引用会保留并提示重新选择，避免悄悄丢弃筛选条件。

SQL 表达式用于计算等高级场景，输入不带语句结束分号或注释的表达式；自定义表达式里的别名由使用者维护。生成器检查标识符、字面量、连接引用和结构完整性，但不替代数据库的类型、分组语义和权限校验。只读连接仍由执行端限制操作。

## 从 SQL 编辑器导入 SELECT

选好连接，点击「在查询构建器中打开」。有选区时导入选中的 SQL，否则导入整个编辑区。导入成功后会打开独立的设计标签，保留原 SQL。设计沿用连接配置；临时表、事务等会话状态仍属于原编辑器。原查询没有 LIMIT 时，导入的设计也没有行数限制。

支持有表来源的 SELECT，也支持无 FROM 的常量或参数投影，包括单表或带 ON 条件的多表连接、DISTINCT、表与字段别名、常用聚合、AND／OR／NOT、IN、BETWEEN、IS NULL、GROUP BY、HAVING、ORDER BY、LIMIT 和 OFFSET。未限定的列与排序别名保留原写法。SQLite、PostgreSQL 支持双引号标识符，MySQL 支持反引号标识符。普通字符串用两个单引号表示一个单引号。

例如，在编辑器中选中 `SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC` 后导入，即可在设计中调整分组、聚合或行数限制。预览后的 SQL 在新的编辑器中打开，由用户执行。

CTE、子查询、INTERSECT、EXCEPT、窗口函数、原生位置参数、注释及任意计算表达式暂不支持反向导入。遇到无法映射的写法时，编辑器会提示原因。导入限 65,536 个 UTF-16 码元、4,096 个词元和 16 层括号。其余差距见[完整功能矩阵](navicat-completeness.md)。


## 在设计中使用命名参数

例如，导入 `SELECT region, amount FROM sales WHERE amount >= :minimum ORDER BY amount DESC LIMIT :page_size OFFSET :skip`。条件编辑器中可以修改参数名，也可以将一个固定值的表达式类型改为「命名参数」。参数名输入框只填名称，LIMIT 和 OFFSET 输入框则填写完整的 `:name`。每处引用可独立编辑，同名引用在运行时共用一个值。聚合函数的参数位置目前只接受字段，COUNT 还可使用星号。

点击「在 SQL 编辑器中打开」后运行，选择类型并输入实际值。分页参数预选整数类型。构建器保存并交接占位符，实际值由编辑器按[命名参数查询](query-parameters.md)的规则处理。单条语句至多使用 128 个不同名称、1,024 次参数引用，每个名称至多 128 个 ASCII 字符。


## 合并多个 SELECT

在编辑器选中完整的复合查询，点击「在查询构建器中打开」。也可以在已有设计中点击「添加 UNION 分支」，默认以 UNION ALL 保留重复行。切换「编辑 SELECT 分支」后，表、字段、连接条件和筛选只修改当前分支。从第二个分支起，可以把它与前段结果的合并方式改为 UNION，此步会去除重复行。

例如，`SELECT region AS area FROM customers UNION ALL SELECT region FROM leads ORDER BY area LIMIT :size`。先在第二段修改筛选，再用「合并结果排序」按输出列名或从 1 开始的列序号排列。末尾的 ORDER BY、LIMIT 和 OFFSET 作用于整个合并结果，分页参数交回编辑器时预选为整数。

最多可组合 32 段。显式输出的列数须一致；已连接时，构建器读取表或视图元数据核对星号投影的列数，发现不一致时会阻止交接。离线或无法读取列数时，预览会标明未核实。当前支持无括号的平铺 UNION 和 UNION ALL，暂不支持为单个分支单独排序或分页。
