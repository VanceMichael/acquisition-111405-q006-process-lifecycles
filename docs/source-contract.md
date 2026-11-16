# 来源与既有应用契约

## 新来源

GET /log 返回logId、globals(event属性默认值)、classifiers(名称及keys)、fragments、closed。分片trace含traceId和events；event含eventId、attributes，属性值为{type,value}，type支持string/int/date/boolean。覆盖仅按键是否存在判断，false和0覆盖默认。lifecycle:transition有start/complete/suspend/resume；concept:instance存在时才可据其与traceId确定同一执行，缺省时保留未关联。分片中同eventId且内容不一致为冲突，不静默覆盖。输出traceId、eventId、attributes、executionId(可空)、association(explicit/unresolved)；事件到达次序与来源时间同时保留。 同eventId内容冲突的两份候选都保留原文，当前records不发布其中任一为确定事件；trace中独立无冲突的事件不受影响。

本地来源只实现以上明确子集，不要求补全同类公开标准。未声明的字段与语法不得自动解释成有效业务事实。样本中的所有人员、账户、样本、设备与文件内容均为合成资料，无生产访问凭据。

## 接收端解释规则（已实现）

`mode: 'source'` 的实现在 `src/source.mjs`，通过真实 HTTP 领取 `/log` 与其声明的全部分片，规则如下：

- **轨迹与到达次序**：每条分片的 `traces` 原样保留；事件按分片清单顺序与片内次序赋予连续 `arrivalIndex`，记录按该次序发布，不按任何时间字段重排或就近配对。
- **分类器与全局默认**：`classifiers`、`globals` 原样存入结果的 `log` 段与归档元资料，不解释未声明字段。
- **属性来源可区分**：事件属性单元保留 `{type,value}` 并加 `origin`：事件实际覆盖为 `"event"`，继承全局默认为 `"global"`；另以 `overrideKeys`/`inheritedKeys` 列明。覆盖仅按键是否存在判断，`false`、`0` 同样覆盖默认。非法单元不解释为业务事实，保留 `raw` 并登记 `event-attribute-malformed`。
- **执行关联**：仅当事件显式携带 `concept:instance` 时，才与 `traceId` 共同确定执行（`association: "explicit"`、`executionId` 为该值）；缺省一律 `association: "unresolved"`、`executionId: null`，绝不按时间最近把 start/complete 配成一次执行。
- **生命周期与闭合**：只承认 `start/complete/suspend/resume`。执行缺 `start` 报 `missing-start`、缺 `complete` 报 `missing-complete`，缺少阶段不推断开始/结束时间、不产生零耗时记录（结果中没有 duration 字段）。补送的“只有 complete”事件因此保留为开放执行而非错误配对。
- **冲突**：同一 `eventId` 出现内容不一致或跨轨迹候选时，两份候选都随原文证据保留在 `event-conflict` 问题中，`records` 不发布其中任一；同轨迹内其他无冲突事件照常发布。完全一致的重复事件安全去重，`duplicates` 与多片 `evidence` 保留重复事实。
- **部分失败**：单个分片无法领取或格式错误只登记带来源位置（分片序号、路径、状态）的问题，其余安全独立部分继续落库；来源 `closed:false` 登记 `log-not-closed`。任一未决缺口存在时 `complete=false`。

## 归档与回查

索引升级为 `schema: 2`（旧 `schema: 1` 索引仍可读取，首次写入平滑升级）。新增 `meta` 保存日志级分类器、全局默认、分片清单与计数；`issues` 按内容稳定去重，重复领取不膨胀；记录 `id` 为 `logId|traceId|eventId`，修订随内容而定。回查一条执行为何未闭合时，可沿 `executions[].reasons`、对应 `issues[].location` 与记录 `evidence` 中的分片路径，再经 `archive.raw(hash)` 取回 SHA-256 寻址的来源原文。

## 接收接口

既有调用是 `collect({baseUrl, archive, mode})`。`mode` 默认为 `legacy`；新增来源使用 `source`。返回 `{records, complete, issues, evidenceCount}`：`records` 为本次业务结果，`complete` 表示本次领取及解释是否有未决缺口，`issues` 为带来源位置的可复核问题，`evidenceCount` 为实际接收的原文数。新结果可增加字段，示例不是封闭 schema。

每个落库记录的 `id` 必须非空且稳定，由业务身份决定；业务所需的多身份关系不能都压缩进 `id`。`archive.commit` 接受 `records`、`exchanges` 与 `issues`；原文在 `raw/` 以 SHA-256 寻址，索引引用原文与记录修订。既有归档索引 schema=1 可以扩展，但旧摘要记录必须仍可读取。

应用不得伪造原文，也不能把摘要模式当成新来源成功。HTTP 相对链接基于来源 origin 解析，不能访问其他站点。错误状态、缺数据和空的有效结果应区分。来源解释未决时 `complete=false`，已收的安全独立部分可以保留。

## 可运行资料

`fixtures/scenarios.json` 提供来源响应及预期业务片段；`expected`/`forbidden` 只供回归断言，采集代码不得读取该文件。来源用真实 HTTP 发送数据，二进制夹具由 `$hex` 或 `$octets` 编码，接收方不会看到这些包装键。`/__requests` 是本地测试用请求审计接口，不是资料源。

连续相同 method/path 响应可按数组次序变化，最后一次响应保持；`after` 表达来源步骤先后，`once` 为单次凭证。POST 搜索会按来源能力拒绝不支持的条件。接收端不需要实现来源服务，也不得删改来源限制来通过测试。

上述契约和题面决定功能范围。公开回归提供正常与有冲突/缺口的样例，并未穷举所有组合；应补充与实际设计相符的边界验证。运行与演示不连接新闻站点或其他线上服务。
