# 流程日志的轨迹归属与生命周期资料接收

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查，并新增 `source` 模式：按来源契约领取日志分片，保留轨迹、分类器、全局默认属性与事件实际覆盖值，给出可确认的执行关联。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收；`npm run test:source` 执行补充的边界与跨领取验证。交付时执行 `npm run verify:complete`，让基线、新来源验收和补充验证同时通过。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `parallel`。单次命令应在90秒内结束，不使用真实客户数据。

## 来源结果的读法

- `records` 每条是一个确定的来源事件，`id` 为 `logId:traceId:eventId`，`traceId`、`eventId`、`attributes`、`arrival`（到达次序）、`occurrences`（每次到达的位置与原文摘要）来自来源；`duration` 恒为 `null`，不按时间最近配对。
- `attributeOrigins` 逐键标明该属性来自 `global` 默认值还是 `event` 实际覆盖；`false` 与 `0` 同样是覆盖。
- `classification` 是采集端依来源声明的分类器键计算的推断值，标有 `derived: true`，不冒充来源字段。日志的 `globals`、`classifiers`、`fragments`、`closed` 原样保存在归档的 `logs` 中。
- `executionId` 只在事件带有 `concept:instance` 时成立，`association` 为 `explicit` 或 `unresolved`；`associationEvidence` 说明该标识来自事件还是全局默认值。未关联事件不会按活动名或时间拼接。
- `executions` 以 `traceId` 与 `concept:instance` 合并且跨多次领取保留：`closure` 为 `closed`/`open`/`unclosed`/`unknown`，`missing` 列出缺少的阶段，`evidence` 指向具体事件与原文摘要。`suspend`/`resume` 原样保留但不当作开始或结束。
- `complete=false` 表示本次领取或解释仍有未决缺口（未声明关闭、分片失败、属性无效、同 `eventId` 冲突等）；`issues` 中每条都带来源位置，`severity` 区分 `error`/`warning`/`notice`。
- 同 `eventId` 且内容不一致的候选两份原文都入归档，`records` 不发布其中任一，`conflicts` 与 `issues` 给出可回查的候选和原文摘要。比较范围是同一轨迹；不同轨迹中的同名事件各自独立。

## 容器

```sh
docker build -t acquisition-process-lifecycles:local .
docker run --rm --network none acquisition-process-lifecycles:local
docker run --rm --network none acquisition-process-lifecycles:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令依次执行基线回归、新来源验收、补充边界验证和完成后的演示，不让未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式保留，`source` 模式转交 `src/source.mjs`。
- `src/source.mjs` 负责来源日志、分片与事件的解释、冲突判定和跨领取执行合并。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
