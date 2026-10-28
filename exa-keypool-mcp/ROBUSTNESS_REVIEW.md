# 鲁棒性审计：0.1.0 → 0.1.1

日期：2026-10-28。基线提交：`5f3e8a97d88ffe444e9b9d7ef481f925b3c6030d`。

## 结论

0.1.0 的 19 项测试证明了基本流程可用，但没有覆盖关键并发、异常分类和进程生命周期边界。这次新增 16 项测试；其中第一批 11 项在修复前有 8 项失败，修复后全套 35 项通过。

0.1.1 适合个人本地试用。不能据此承诺“生产稳定”：没有真实 Exa 三账号联调、真实 Claude Code 客户端验证、跨操作系统验证或长时间浸泡测试。保持官方原生搜索可用。

## 对照的开源实现

阅读实现后借鉴设计原则，没有复制这些项目的代码，也没有引入它们作为额外运行依赖。

| 项目 / 阅读位置 | 对照重点 | 本项目处理 |
|---|---|---|
| [Exa 官方 MCP：stdio](https://github.com/exa-labs/exa-mcp-server/blob/main/src/stdio.ts)、[错误处理](https://github.com/exa-labs/exa-mcp-server/blob/main/src/utils/errorHandler.ts)、[响应清理](https://github.com/exa-labs/exa-mcp-server/blob/main/src/utils/exaResponseSanitizer.ts) | 使用官方 MCP SDK；按错误类型选择重试；对白名单字段和异常响应做清理 | 保留相同 SDK 接入方向，收紧异常分类和响应字段；不跟随官方所有重试策略，以控制重复计费 |
| [LiteLLM cooldown handlers](https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/cooldown_handlers.py) | 区分调用者/部署级故障；按错误类型冷却；多 worker 使用共享状态 | key 级 401/402/403/429 与服务级 5xx 分开；修复并发冷却竞态；明确当前仅进程内状态，不引入 Redis |
| [p-retry](https://github.com/sindresorhus/p-retry/blob/main/index.js) | 非网络 TypeError 不重试；取消前后检查；用单调时钟衡量时间 | 只重试明确传输错误或单次超时；成功返回前再次检查取消；冷却改用单调时钟，HTTP 日期用墙上时钟换算 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)（实际安装 v1.32.2） | stdio 缓冲上限、连接关闭时中止处理器、取消通知传播 | 复用 SDK 取消机制；补 stdin EOF/close 和 stdout error 生命周期处理；显式限制输入缓冲 256 KiB |

读取时源码 blob SHA（不是 commit SHA；用于识别审计快照）：

- Exa `src/stdio.ts`: `fb2e7a0223af50209a55d50dc8314906f05e719e`
- Exa `src/utils/exaResponseSanitizer.ts`: `43acb8da86a023b051f660b83bdb4b317e91ee79`
- LiteLLM `litellm/router_utils/cooldown_handlers.py`: `330500789a43eaa392063de09426c9d577e868f5`
- p-retry `index.js`: `985a7968a3e6d59fa04d99ed80306c235295f687`

## 发现与修复

| 风险 | 旧行为 / 复现 | 修复 |
|---|---|---|
| 并发绕过全池冷却 | 请求 A 收到 503 后，请求 B 收到 402 仍继续尝试第三个 key | 每次选择下一 key 前重新检查全局冷却；不取消已经发出的其他请求 |
| 冷却时间被缩短 | 并发 503 的 900 秒等待可被后到的 20 秒覆盖 | 全局冷却取已有和新要求的最大值 |
| 异常触发无效重试 | HTTP 204 空 body、本地 TypeError 被当作网络错误换 key | 空响应报 INVALID_RESPONSE；只对白名单网络错误码和单次超时做有限重试 |
| 清理失败掩盖状态 | cancel body 抛异常会把 429 的 900 秒冷却变成网络错误的 15 秒 | 清理错误被隔离，不覆盖 HTTP 状态，也不等待清理阻塞切换 |
| 退出不及时 | stdin EOF 时若仍有其他活跃句柄，旧进程继续存活 | EOF/close/SIGINT/SIGTERM 主动关闭 MCP、终止处理器并退出；stdout 错误退出 |
| 输出不可靠 | URL 被硬截断成无效引用，文档片段锚点被删；warning 任意对象整体透传 | 超长 URL 丢弃并标注截断；保留返回 URL 锚点；warning 只保留 code/message/path |
| 脱敏顺序错误 | 含引号/反斜线的 key 在序列化后匹配失败 | 字符串值先脱敏再 JSON 转义，优先匹配长 key |
| 空抓取被误报成功 | Contents HTTP 200 但无可读页面仍作为成功工具结果 | exa_fetch 返回 CONTENT_UNAVAILABLE 和可用状态信息；空搜索仍是合法空结果 |
| 时钟调整影响冷却 | 系统时间跳变会提前/推迟释放 key | 使用单调时钟衡量冷却时长；HTTP 日期仅在收到时换算 |

## 验证证据

- `npm run check`：四个源码模块语法检查通过。
- `npm test`：35/35，零失败。Node 24.22.1 / Linux。
- 真实 Node fetch + 本地 HTTP socket：429 切换请求头/负载、响应体卡住的总超时、连接重置最多两次、通过 MCP 客户端取消后关闭 HTTP 连接。
- 官方 SDK 客户端 + 真实 stdio 子进程：初始化、工具列表、状态调用、EOF 退出、超大输入退出。
- 300 次模拟成功请求，以三并发分批调用；最后 active=0、每个 key inflight=0、每个 key 成功 100 次。这是并发一致性检查，不是生产负载压测，也不是长时间内存泄漏证明。
- 未增加运行依赖；仍使用固定 SDK 1.32.2 / Zod 4.6.7。此前同日依赖审计为 0 漏洞。

## 保留的设计限制

1. 单进程 fail-fast：并发已满立即返回 BUSY，不建立无界队列。多个 Claude Code 会话不共享余额、并发、冷却或统计。
2. 不监控真实余额；402 默认一小时后允许再试。重启清除状态，额度月底恢复不自动感知。
3. 超时重试仍可能重复计费；最多两次传输尝试不能提供 exactly-once 语义。
4. 不新增 Redis、数据库、定时调度或常驻 HTTP 服务。个人三 key 场景暂不需要这类运维负担。
5. 不声称支持所有 Exa 官方 MCP 工具，也没有为了跟随 SDK 主分支而进行无必要的大版本迁移。
6. 下一项最有价值的验证是使用真实 key，在用户机器上完成一次搜索、一次抓取，再观察正常日常使用。不要用高频请求人为耗尽额度来测试切换。
