# codex-vscode 多 Agent 编排：现状分析与设计方案

状态：**待评审（第 2 版，已纳入评审决策）**，评审通过后再进入实施。
撰写日期：2026-09-22
对应 codex 版本：`protocol-version.txt` = 0.150.0-alpha.8

## 已确认的决策

| 编号 | 决策 | 影响 |
|---|---|---|
| D-1 | **只支持 multi-agent v2**，要求用户开启 `features.multi_agent_v2` | 事件源改为 `subAgentActivity`；放弃 v1 的 `collabAgentToolCall` 驱动路径；**直接输入能力整体删除** |
| D-2 | Agent 详情**提升为父 tab 下的嵌套子 tab** | 线程注册表需父子同构；tab 栏需支持两级 |
| D-3 | **保持现有的全量自动批准**（`autoApprove = true`） | 审批只需做展示归属，不需要新的交互流；风险由用户自担 |

---

## 1. 背景与目标

`codex-vscode` 已经能在父会话的对话流里显示一块「子 Agent（N）」卡片列表。但它只是一个只读的
状态指示器：看不到子 agent 在做什么，点不进去，也无法干预。而且（见 §3.1）**这套卡片在 v2 下
根本不会出现**，因为它是按 v1 的事件形状写的。

目标：

1. **可观测**：能看到每个子 agent 的实时输出、工具调用和文件改动。
2. **可导航**：父会话与各子 agent 之间以嵌套 tab 切换，能看到 agent 树的结构。
3. **可干预**：能中断单个子 agent。
4. **可信**：状态、计数、归属必须与引擎实际状态一致。

非目标：编排的可视化编辑、跨工作区 agent 管理、agent 角色配置界面、v1 兼容。

---

## 2. 现状分析

### 2.1 当前实现

```
codex app-server  --(JSON-RPC over stdio)-->  extension.ts  --(postMessage)-->  webview/App.tsx
```

- `src/appServerClient.ts`（170 行）：极简 JSON-RPC 客户端，单进程单连接，按行分帧。
- `src/extension.ts`（1320 行）：全部宿主逻辑。模块级可变全局量持有状态：
  `client` / `view` / `activeThreadId` / `openSessions` / `sessionTitles` / `turnIds` / `fileChanges`。
- `webview/src/App.tsx`（679 行）：`tabs: Tab[]` 是每个会话的 block 列表，
  `agents: Record<string, AgentInfo>` 是一个与 tab 平行的、扁平的子 agent 字典。

子 agent 逻辑集中在：宿主 `extension.ts:160-248` 的 `handleNotification`；
webview `App.tsx:148-204`（三个 case）、`App.tsx:424-449`（渲染）、`App.tsx:313-322`（block 插入）。

### 2.2 缺陷清单

**D1 — 用字段形状猜类型，而非用 `type` 判别式。**
`ThreadItem` 是带 `"type"` tag 的联合类型，但宿主是这样分流的：

```ts
if (typeof item.command === 'string') { /* commandExecution */ }
else if (typeof item.tool === 'string') { /* 认为是 collabAgentToolCall */ }
else if (typeof item.agentThreadId === 'string') { /* subAgentActivity */ }
```

`mcpToolCall` 和 `dynamicToolCall` 同样有 `tool: string`，会被误渲染成子 agent 卡片。
根因是通知路径全是 `any`，`src/generated` 的 300+ 生成类型在这条路径上一个都没用。

**D2 — 卡片在 v2 下不会出现。** 详见 §3.1。这是 D-1 决策后最重要的一条。

**D3 — 同一个 agent 可能出现两张卡片。**（v1 路径）spawn 的 `item/started` 里
`receiverThreadIds` 必为空，代码退化成用 `callId` 做 key，
真实 threadId 到达后会再插一条，旧的永不清理。

**D4 — 活动事件的完成判定永远不成立。**
`App.tsx:194` 判的是 `m.kind === 'Completed'`，协议里是小写 `"completed"`。
**在 v2 下这条尤其致命**，因为 `subAgentActivity` 是 v2 唯一的生命周期信号源。

**D5 — 生成的协议类型已过期。**
`src/generated/v2/CollabAgentToolCallStatus.ts` 只有 3 个值，当前仓库的 schema 有 4 个
（多 `interrupted`）。且生成时没带 `--experimental`，
`Thread.canAcceptDirectInput`、`ThreadListParams.parentThreadId` / `ancestorThreadId` 全部缺失。

**D6 — 卡片列表作用域错误。** 渲染时按 `a.parentThreadId === activeId` 过滤，
读的是全局 `activeId` 而非 block 自身线程。目前靠"只渲染激活 tab"侥幸正确，
引入嵌套 tab（D-2）后会直接串台。

**D7 — 位置固定。** agents block 只在首次 spawn 时追加一次，
后续所有 agent 挤在同一位置，无法按时间线交错。

**D8 — 工程结构。** `extension.ts` 1320 行，跨线程状态全是模块级全局量。

### 2.3 最根本的问题

> **子 agent 的输出根本没有到达这个扩展。**

app-server 的事件监听器是 **per-thread** 挂载的。一个连接只有对某个 threadId 执行过
`thread/start` 或 `thread/resume` 之后，才会收到该线程的 `item/*`、`turn/*` 通知
（`app-server/src/request_processors/thread_lifecycle.rs` 的 `ensure_conversation_listener`
→ `try_ensure_connection_subscribed`）。

父线程里的 `subAgentActivity` 只是**摘要信号**，不含子 agent 的实际工作内容。
所以核心工作量在宿主侧的订阅管理，不在 webview。

---

## 3. 引擎与协议约束（事实核查）

以下结论均经过 Rust 源码核对，是设计的硬约束。

### 3.1 v2 的事件形状（本方案的唯一目标形态）

| 行为 | v2 发出的事件 | 源码位置 |
|---|---|---|
| 派生 agent | `subAgentActivity` — `kind: "started"`, `agentThreadId`, `agentPath` | `multi_agents_v2/spawn.rs:242` |
| 向 agent 发消息 | `subAgentActivity` — `kind: "interacted"` | `multi_agents_v2/message_tool.rs:131` |
| 中断 agent | `subAgentActivity` — `kind: "interrupted"` | `multi_agents_v2/interrupt_agent.rs:89` |
| agent 结束 | `subAgentActivity` — `kind: "completed"` | `core/src/session/mod.rs:2434` |
| 等待 agent | `collabAgentToolCall` — `tool: "wait"` | `multi_agents_v2/wait.rs:77` |

两条必须注意的细节：

**(a) v2 的 spawn 不发 `collabAgentToolCall` 这个 turn item。**
`multi_agents_v2/spawn.rs` 里确实构造了 `CollabAgentToolCallItem`，但它只传给
`analytics.track_collab_tool_call`，**不进 turn item 流**。UI 可见的只有 `subAgentActivity`。
这就是 D2 的成因。

**(b) v2 的 `wait` 事件不携带目标信息。**
`wait.rs` 发出的 `CollabAgentToolCallItem` 里
`receiver_thread_ids: Vec::new()`、`receiver_agents: Vec::new()`、`prompt: None`，
`agentsStates` 因此也是空的。

> **推论：`agentsStates` 在 v2 下不可用。** 上一版方案里"用 `agentsStates` 驱动未订阅 agent
> 的状态"这一设计不成立，必须换成 §3.3 的推送式状态。

作为对照，v1（`core/src/tools/handlers/multi_agents/`）的五个工具每个都发真正的
`collabAgentToolCall` 且带 `agentsStates`，但没有 `subAgentActivity`、没有 `agentPath`。
两代形状不兼容，这是 D-1 决定只做 v2 的直接原因。

### 3.2 子线程必须显式订阅

- `thread/resume { threadId }` 把当前连接订阅到该线程。对**正在运行**的线程走"重新加入"路径
  （`handle_pending_thread_resume_request`，注释为 "Rejoining a loaded thread"），
  不会重启或打断它。
- 订阅后该子线程的 `item/*`、`turn/*` 通知开始推送，`params.threadId` 即子线程 id。
- `thread/unsubscribe { threadId }` 解绑，返回
  `"notLoaded" | "notSubscribed" | "unsubscribed"`。

### 3.3 订阅决定 transcript，不决定状态（已实测）

这一节前后改过两次，现在的结论来自 `e2e/multi-agent.js` 的实跑，不再是读代码的推断。

实测：子 agent 被 spawn 后、本连接订阅它之前，这条连接收到的该子线程通知只有
`thread/status/changed` 和 `warning`，**没有任何 `item/*`**。
订阅（`thread/resume`）之后，`item/started`、`item/completed`、
`item/agentMessage/delta`、`turn/completed` 才开始到达。

所以两类信号要分开看：

| 信号 | 未订阅时 | 用途 |
|---|---|---|
| `thread/status/changed` | **能收到** | 存活状态（运行中 / 完成 / 出错） |
| `item/*`、`turn/*` | 收不到 | transcript、工具调用、文件变更 |

> 此前两版文档分别断言过"状态可以免订阅拿到"和"状态也必须订阅才有"，
> 两者都不准确。正确的切分是上表这条线。

这对设计有两个后果：

1. 订阅仍是必需品——要看子 agent 干了什么就必须订阅，§4.4 的策略保留。
2. 但 LRU 驱逐的代价比原先估计的小得多：被驱逐的 agent 丢的是后续 transcript，
   状态仍然准确。`AgentRegistry.applyStatus()` 就是为此存在的，
   `extension.ts` 在 `thread/status/changed` 上直接喂给它，与订阅与否无关。

另一条实测结论：**刚 spawn 的子 agent 不能立刻 resume**。
引擎先广播 `subAgentActivity`，rollout 文件稍后才落盘，这个窗口里
`thread/resume` 会报 `rollout at ... is empty`。实测需要约 250–500ms。
`SubscriptionManager` 因此对这个特定错误做有限重试（5s 预算、250ms 间隔）。

### 3.4 agent 树在不依赖实验字段的前提下可构建

两条路：

1. **稳定路径（采用）**：`thread/loaded/list` 取内存中所有线程 id → 逐个 `thread/read` →
   从 `thread.source` 取 `SessionSource::SubAgent(ThreadSpawn { parentThreadId, depth,
   agentPath, agentNickname, agentRole })` → 按父子边 BFS。`SessionSource` 是稳定字段。
   **TUI 就是这么做的**（`tui/src/app/loaded_threads.rs`）。
2. **实验路径（可选快路径）**：`thread/list { parentThreadId }` / `{ ancestorThreadId }`。
   两个字段都带 `#[experimental]`，需 `initialize` 声明 `experimentalApi: true`
   （扩展已在声明），但生成的 TS 里没有。

另外，稳态下大部分节点可以直接从广播的 `thread/started` 拿到，
`thread/loaded/list` 只在冷启动和崩溃重连时用于回填。

### 3.5 v2 子 agent 禁止直接输入（D-1 的直接后果）

```rust
// app-server/src/request_processors/thread_input.rs
pub(super) fn can_accept_direct_input(
    multi_agent_version: Option<MultiAgentVersion>,
    session_source: &SessionSource,
) -> bool {
    multi_agent_version != Some(MultiAgentVersion::V2)
        || !matches!(session_source, SessionSource::SubAgent(SubAgentSource::ThreadSpawn { .. }))
}
```

对 v2 子线程调用 `turn/start` 一律被拒，错误为
`direct app-server input is not allowed for multi-agent v2 sub-agents`。

**既然只做 v2，`canAcceptDirectInput` 对子 agent 恒为 false。**
数据模型里不需要这个字段，UI 里不需要输入框，也不需要能力探测降级——
子 agent 详情页就是只读的。这反而让方案简化了。

### 3.6 审批请求带线程归属

`CommandExecutionRequestApprovalParams` 头三个字段是 `threadId` / `turnId` / `itemId`。
当前 `handleServerRequest` 完全忽略 `threadId`。按 D-3 保持全量自动批准，
因此这里**只需要做展示归属**：自动批准的状态行应能说明是哪个 agent 触发的。

### 3.7 前置条件：v2 多数情况下已默认生效（本轮更正）

> **更正**：上一版本文档称 v2 必须用户显式开启。实测并非如此——默认模型自己就声明 v2。

生效版本由 `Config::multi_agent_version_for_model` 三级决定：

1. `features.multi_agent_v2` 开启 → 强制 `v2`（该 flag 确实 `default_enabled: false`）；
2. 否则取**模型目录声明的** `Model.multiAgentVersion`；
3. 否则 `multi_agent`（v1，默认开）→ `v1`。

对 codex `0.150.0-alpha.8` 实测（10 个模型，6 个声明了版本）：

```
gpt-5.6-sol            -> v2   (default)
gpt-5.6-terra          -> v2
gpt-5.6-luna           -> v1
gpt-daybreak-*-latest  -> v2
codex-auto-review      -> v1
multi_agent:    enabled=true   (default)
multi_agent_v2: enabled=false  (default)
```

即**默认模型就是 v2**，所以 v2-only（D-1）是默认路径而非小众配置。
探测逻辑必须复刻这三级，只看 feature flag 会把绝大多数用户误判成 v1。

落在非 v2 的用户（例如选了 `gpt-5.6-luna`）走引导：
`experimentalFeature/enablement/set { multi_agent_v2: true }` 可以**按进程**运行时启用，
不写 config.toml，适合做"为本次会话启用"的一键操作。

### 3.8 TUI 参考实现

| 关注点 | TUI 模块 |
|---|---|
| agent 注册表（昵称/角色/运行中/已关闭） | `tui/src/multi_agents.rs`、`agent_navigation` |
| 每线程事件缓冲（非激活线程也缓冲） | `tui/src/app/thread_routing.rs` 的 `thread_event_channels` |
| agent 总览面板 | `tui/src/app/agents_overview*.rs` |
| 冷启动/重连回填 agent 树 | `tui/src/app/loaded_threads.rs` + `backfill_loaded_subagent_threads` |

**关键设计信号**：TUI 并不并发订阅所有子 agent，而是在用户选中时才 resume 附着
（`select_agents_overview_thread` → `resume_target_session`）。本方案沿用（§4.4）。

---

## 4. 设计

### 4.1 目标交互（按 D-2：嵌套 tab）

三层，从轻到重：

1. **行内摘要**：父会话时间线上，每个 `subAgentActivity` 产生一条紧凑事件行
   （`派生 agent Robie [explorer]` / `与 Atlas 交互` / `中断 Bob` / `Robie 已完成`），
   按时间顺序交错。点击事件行跳到对应 agent 的子 tab。
2. **Agent 总览**：父会话内的一个可折叠区块，列出本次会话派生的所有 agent，
   显示昵称/角色、状态、`agentPath`、耗时、token 用量、"等待审批"角标。
3. **Agent 子 tab**：点击进入，成为父 tab 下的嵌套子 tab，显示该 agent 完整 transcript。
   **只读**（§3.5），底部没有输入框，只有「中断」和「打开工作目录」。

tab 栏的两级结构：

```
[ 会话 A ▾ ] [ 会话 B ]          ← 一级：父会话
   └ [ 主线程 ] [ Robie ] [ Atlas ⏳ ]   ← 二级：仅当前父会话展开时显示
```

二级 tab 只在该父会话存在子 agent 时出现；「主线程」恒为第一项。
子 tab 的状态小圆点复用总览的状态色。

### 4.2 模块划分

新代码全部进新模块，`extension.ts` 目标瘦身到 600 行以内，只保留激活、
webview 生命周期和消息分发。

```
src/
  appServerClient.ts        (不变)
  extension.ts              (瘦身)
  protocol/
    items.ts                新增：ThreadItem 判别式解析 → 强类型 ParsedItem
    notifications.ts        新增：通知 → 内部事件映射，替换 handleNotification
    capabilities.ts         新增：multiAgentVersion 探测与未开启时的提示
  threads/
    registry.ts             新增：ThreadRegistry，取代 openSessions/sessionTitles/turnIds/fileChanges
    subscription.ts         新增：子线程订阅管理（resume/unsubscribe/重连恢复/LRU）
  agents/
    tree.ts                 新增：spawn 树构建与回填（对照 TUI loaded_threads.rs）
    orchestrator.ts         新增：agent 状态机
webview/src/
  agents/
    AgentTabs.tsx           新增：二级 tab 栏
    AgentOverview.tsx       新增：agent 总览区块
    AgentDetail.tsx         新增：单 agent 只读 transcript
    useAgentTree.ts         新增：树状态 hook
```

### 4.3 数据模型

宿主侧持有唯一真相，webview 只渲染。

```ts
interface AgentNode {
  threadId: string;
  parentThreadId: string;
  rootThreadId: string;        // 支持多级嵌套时按父会话过滤
  depth: number;

  nickname?: string;           // Thread.agentNickname
  role?: string;               // Thread.agentRole
  agentPath: string;           // v2 必有，来自 subAgentActivity / SessionSource
  cwd?: string;
  model?: string;

  status: AgentStatus;
  waitingOn?: 'approval' | 'userInput';   // 来自 ThreadStatus.active.activeFlags
  spawnedAt: number;
  endedAt?: number;

  subscription: 'detached' | 'attaching' | 'attached';
  transcript: TranscriptBuffer;           // 有硬上限，见 4.6
  fileChanges: Map<string, FileChangeEntry>;
  tokenUsage?: TokenUsage;
}

type AgentStatus =
  | 'running'       // subAgentActivity:started / ThreadStatus:active
  | 'idle'          // ThreadStatus:idle（已派生但当前无活动回合）
  | 'interrupted'   // subAgentActivity:interrupted
  | 'completed'     // subAgentActivity:completed
  | 'failed'        // ThreadStatus:systemError
  | 'closed';       // ThreadStatus:notLoaded / thread/closed
```

注意这里**没有** `canAcceptDirectInput`（恒 false，§3.5）、
**没有** `statusMessage`（那是 `CollabAgentState` 的字段，v2 下拿不到，§3.1b）。

`AgentNode` 与父会话节点存在同一张 `ThreadRegistry` 表里（父会话是 `depth: 0`、
无 `parentThreadId` 的节点），这样订阅、文件变更、transcript 三套逻辑对父子线程是同一套代码，
也是 D-2 嵌套 tab 能低成本实现的前提。

### 4.4 订阅策略：发现即附着，按 LRU 限量

§3.3 更正后，未订阅的 agent 除了名字和一个存活提示之外什么都拿不到，
所以"等用户点开再订阅"会让列表长期停在无信息状态。改为**发现即附着**，用 LRU 控制总量。

订阅配方直接照搬 TUI（`app_server_session.rs` 的 `ResumeModelSettings::PreserveExistingThread`）：

```ts
await request('thread/resume', { threadId });   // 只传 threadId，不带任何 override
```

只传 `threadId` 是关键——任何 model / cwd / permissions 字段都会改写目标线程的设置，
而目标可能正跑在轮次中间。失败时按 TUI 的判据回退：
错误信息含 `already has an active writer` 时改用 `thread/read { includeTurns: true }` 取只读快照。

| 触发 | 动作 |
|---|---|
| 父线程上出现 `subAgentActivity` | 注册节点 → 立即 `thread/resume`（去重并发） |
| resume 成功 | `attachment: 'live'`，回填 `parentThreadId` / 昵称 / 角色 / cwd / `canAcceptDirectInput` |
| resume 报 active-writer | 回退 `thread/read` → `attachment: 'readOnly'`，有历史无实时流 |
| 订阅数超过 8 | LRU 淘汰最久未活动的，`thread/unsubscribe`，标回 `detached` |
| `turn/started` 到达 | 刷新该线程的 LRU 位置，并记录 `turnId` 供中断使用 |
| 父会话关闭 | 解绑其所有后代，清理节点 |

阈值取 8 而非 TUI 的按需，是因为 webview 的渲染成本远低于终端重绘，
而 v2 的并发上限本身受 `multi_agent_v2.max_concurrent_threads_per_session` 约束。

### 4.5 事件流

`protocol/notifications.ts` 按 `item.type` 判别，产出内部事件：

```
item/started | item/completed
  ├── "subAgentActivity"     → orchestrator.onActivity(kind, agentThreadId, agentPath)
  ├── "collabAgentToolCall"  → orchestrator.onWait(status)        // v2 下只有 wait，无目标信息
  ├── "commandExecution"     → registry.appendTranscript(threadId, ...)
  ├── "fileChange"           → registry.recordFileChanges(threadId, ...)
  ├── "mcpToolCall"          → registry.appendTranscript(...)     // 不再误判为 agent
  └── ...
thread/started               → orchestrator.onThreadStarted(thread)   // 按 source 判断是否子 agent
thread/status/changed        → orchestrator.onStatus(threadId, status)  // 仅对已订阅线程会到达
thread/closed                → orchestrator.onClosed(threadId)
turn/started | turn/completed → registry.setTurnState(threadId, ...)   // turnId 供中断使用
thread/tokenUsage/updated    → registry.setTokenUsage(threadId, ...)
```

**`thread/started` 和 `thread/status/changed` 都是广播的**，会带来与本扩展无关的线程。
必须按"`source` 为 `SubAgent(ThreadSpawn)` 且 `parentThreadId` 能链回本扩展持有的某个根会话"
过滤，否则会出现幽灵 agent。

### 4.6 资源上限

- 每个 agent 的 transcript 缓冲上限（建议 256 KB 文本 / 2000 条 block），
  超出从头部丢弃并显示"已省略较早输出"。
- 后台订阅数上限 3（§4.4）。
- webview 按线程分片 + `memo`，避免一个 agent 的 delta 触发整棵树重渲染。

### 4.7 审批（按 D-3：保持自动批准）

保持 `autoApprove = true` 的现有行为，不新增交互。仅做两处展示改进：

- 自动批准的状态行带上来源 agent 的昵称，便于事后追溯。
- Agent 总览里，`ThreadStatus.active.activeFlags` 含 `waitingOnApproval` 的 agent 打角标
  （在自动批准的间隙可能短暂出现，也覆盖将来关闭自动批准的情况）。

### 4.8 干预能力

- **中断单个 agent**：对子 threadId 发 `turn/interrupt { threadId, turnId }`，
  turnId 从该线程的 `turn/started` 记录。
- **打开 agent 的 cwd / rollout 文件**：本地能力，无协议风险。
- **不提供**向 agent 追加输入（§3.5 协议禁止）。
- **不提供**客户端关闭 agent（协议未暴露；`close_agent` 是模型用的工具）。
  UI 上的"移除"只做视图移除 + 解绑。

---

## 5. 分阶段实施计划

每阶段可独立验证和回退。估时按单人计。

> **实施状态（本轮）**：阶段 0–5 已落地，实现与下列计划的偏差记录在 §5.1。
> 尚未做端到端联调——本机没有可用的模型凭据（`~/.codex` 无 `auth.json`，
> 只有需要 `VENUS_API_KEY` 的自定义 provider），跑不出真实的多 agent 会话。

### 阶段 0 — 协议对齐与 v2 门控（0.5–1 天）

- `codex app-server generate-ts --out src/generated --experimental` 重新生成类型，
  更新 `protocol-version.txt`。
- 新建 `src/protocol/items.ts`：按 `item.type` 判别式解析，导出强类型 `ParsedItem`。
- `handleNotification` 改为消费 `ParsedItem`，删除全部字段形状嗅探。
- 新建 `src/protocol/capabilities.ts`：读 `Model.multiAgentVersion`；
  非 v2 时在 agent 区域显示引导（如何在 config.toml 开启），而不是静默空白。

**验收**：MCP / dynamic 工具调用不再被渲染成子 agent；通知路径无 `any`；
未开启 v2 时有明确提示。
**修复**：D1、D5。

### 阶段 1 — v2 事件驱动的 agent 列表（1–1.5 天）

- 删除 v1 的 `collabAgentToolCall→spawnAgent` 卡片路径。
- 以 `subAgentActivity` 为唯一生命周期源建立 agent 列表（修 D4 的大小写）。
- 接入 `thread/started` / `thread/status/changed` / `thread/closed` 三个广播，
  按 §4.5 过滤，维持未订阅 agent 的准确状态。
- 行内摘要事件行（§4.1 第 1 层），按时间线交错（修 D7）。
- 列表按所属线程过滤而非 `activeId`（修 D6）。

**验收**：v2 下派 3 个 agent，列表恰为 3 条且状态随引擎实时变化；
全部结束后均为终态；中断某个 agent 后状态正确变为 `interrupted`。
**这一步结束即可发布一个"v2 下准确的只读概览"版本。**

### 阶段 2 — 状态层重构（1.5–2 天）

- 新建 `src/threads/registry.ts`，收编 `openSessions` / `sessionTitles` / `turnIds` /
  `fileChanges` / `activeThreadId`，父子线程同构（D-2 的前提）。
- 新建 `src/agents/orchestrator.ts`、`src/agents/tree.ts`
  （`thread/loaded/list` + `thread/read` 的 spawn 树 BFS 回填，对照 TUI `loaded_threads.rs`）。
- `extension.ts` 相应瘦身。

**验收**：关闭重开面板、重启 VS Code、app-server 崩溃重连后 agent 树都能正确恢复；
`extension.ts` 行数显著下降。
**修复**：D8。

### 阶段 3 — 子线程订阅（2–3 天，核心）

- 新建 `src/threads/subscription.ts`：按 §4.4 做 attach / detach / 重连恢复 / LRU。
- 子线程的 transcript、文件变更、token 用量落到对应 `AgentNode`。
- 子线程文件变更汇总到根会话的变更列表（撤销仍走现有 git 逻辑）。
- transcript 缓冲上限（§4.6）。
- 自动批准状态行带来源 agent（§4.7）。

**验收**：打开一个运行中 agent 能看到实时输出；离开再回来内容不丢；
崩溃重连后订阅自动恢复。

> **技术风险集中点。** 建议开工前先花半天写一次性验证脚本，确认
> `thread/resume` 对运行中 v2 子线程的行为（是否打断、历史如何返回、
> 父线程 `historyMode: "paginated"` 是否影响子线程），结论不符再回头调整方案。

### 阶段 4 — 嵌套 tab 界面（2–3 天）

- `AgentTabs.tsx`：二级 tab 栏（§4.1），状态点、运行中动画、点击切换。
- `AgentDetail.tsx`：只读 transcript，复用现有 Markdown / 工具输出 / 文件卡片组件。
- `AgentOverview.tsx`：总览区块，含 `agentPath`、耗时、token、等待审批角标。
- 按线程分片渲染 + memo。

**验收**：5 个并发 agent 下界面不卡顿；子 tab 切换不丢状态；
子 tab 内没有输入框（只读语义清晰）。

### 阶段 5 — 干预能力（0.5–1 天）

按 §4.8 实现中断、打开 cwd / rollout。（因删除了直接输入，工作量比上一版少。）

**验收**：中断只影响目标 agent，父会话与其它 agent 不受影响。

### 阶段 6 — 可选增强（按需）

跨 agent 文件变更合并评审面；导出包含子 agent；agent 耗时/成本统计；agent 树的图形化展示。

**合计**：阶段 0–5 约 **8–11.5 天**。

### 5.1 实施结果与计划偏差

落地的模块：

| 文件 | 职责 |
|---|---|
| `src/protocol/notifications.ts` | 唯一的 wire → `ServerNotification` 转换点 |
| `src/protocol/items.ts` | `ThreadItemOf<K>` 判别式窄化 + diff 统计 |
| `src/protocol/capabilities.ts` | 三级版本解析、运行时启用 v2 |
| `src/agents/registry.ts` | agent 树、状态归并、父子关系 |
| `src/agents/subscriptions.ts` | resume/read 附着、LRU、unsubscribe |

与计划的偏差：

1. **通知层没有自造 `ParsedItem`。** 生成的 `ServerNotification` 本身就是按 `method`
   判别的联合，`ThreadItem` 按 `type` 判别，再包一层中间表示只是重复劳动。
   改为在边界做一次有据可查的类型断言，之后全程走 `switch`。
2. **能力探测不只看 `Model.multiAgentVersion`。** 见 §3.7 更正，必须复刻三级解析。
3. **订阅从"按需"改为"发现即附着 + LRU"。** 见 §4.4，§3.3 更正逼出的必然结果。
4. **阶段 2 的 `ThreadRegistry` 只做了必要的一半。** 没有把父会话状态
   （`openSessions` / `turnIds`）收编成统一注册表——那是纯重构，收益不明确。
   但**文件变更已经归拢到根会话**：`AgentRegistry.rootThreadIdFor()` 沿
   `parentThreadId` 上溯到根，`fileChange` 事件按根线程 id 入账，
   `showDiff` / `undoFiles` 也按根解析。因此子 agent（含孙 agent）改的文件
   会出现在根会话的变更汇总和撤销列表里，无论用户当时看的是哪个 tab。
5. **补了 webview 的类型检查。** 原本 vite 不做类型检查，webview 侧完全没有约束，
   新增 `webview/tsconfig.json` 和 `npm run typecheck`。
6. **写了端到端回归测试，替代原计划的一次性验证脚本。** 见下。

### 5.2 端到端测试（`e2e/`，`npm run test:e2e`）

原计划把联调推迟到"有模型凭据的环境"。实际不需要凭据：本地起一个 HTTP 服务假扮
Responses API、把模型的回复写死，就能让真实的 `codex app-server` 真的去 spawn 子 agent，
这正是 Rust 侧集成测试的做法。测试直接驱动 `AgentRegistry` 和 `SubscriptionManager`，
因此是实现的回归测试而不只是协议探针。

`e2e/harness.js` 是共用的假模型 + CODEX_HOME + 客户端；`e2e/multi-agent.js` 是四个场景，
共 22 项断言，全过：

| 场景 | 覆盖 |
|---|---|
| `basics` | spawn 发现、订阅前后的事件差异、运行中附着、transcript 流、detach |
| `nested` | 子 agent 再 spawn 孙 agent、两层树、`rootThreadIdFor`、`removeTree` |
| `eviction` | 超过上限时 LRU 驱逐、被驱逐 agent 仍有状态推送 |
| `approval` | 子 agent 内触发的审批请求归属于它自己的线程 |
| `refocus` | 被驱逐的 agent 可重新附着，且重连不会重放 transcript |

跑单个场景用 `E2E_ONLY=nested`，看全部通知用 `E2E_VERBOSE=1`。

搭建时踩到的坑，都是不跑起来发现不了的：

| 现象 | 原因 |
|---|---|
| `spawn_agent` 返回 `unsupported call` | v2 的工具在 `collaboration` 命名空间下，function call item 必须带 `namespace` 字段 |
| 子 agent 拿不到 `collaboration` 工具，只有根 agent 有 | `collab_tools_enabled`：v2 下非根 agent 需要**模型自身**声明 v2。测试因此必须用 `gpt-5.6-sol` 这类内置 v2 slug |

最后一条对产品有直接影响：靠 `features.multi_agent_v2` 强开 v2 只能买到**一层**派发，
多层编排要求模型自己声明 v2。`MultiAgentCapability.nestedSpawnSupported` 表达这个区别，
子 agent 列表在降级时会给出提示。
| `CODEX_HOME` 放在 `%TEMP%` 下时 codex 拒绝创建辅助二进制 | 换到 `~/.codex-e2e-home` |

> 排查中一度以为是"请求里 `tools: []`"导致的，据此加过 `CODEX_HOME/models.json` 条目和
> `thread/start` 的显式 `environments`。后来逐个撤掉验证，两者都不必要——
> 引擎里注册的处理器和广告给模型的工具列表是两回事，`tools: []` 并不妨碍工具调用被执行。

测出来的三个实现缺陷，都已修复：

1. **`attachAgent` 会稳定失败**：发现子 agent 后立刻 `thread/resume`，撞上 rollout
   未落盘（§3.3）。`SubscriptionManager` 现在对该错误重试。
2. **`thread/status/changed` 被丢弃**：`handleNotification` 没有这个分支，
   未订阅 / 被驱逐的 agent 状态会一直停在最后一次 `subAgentActivity`。
   现在接到 `AgentRegistry.applyStatus()`。
3. **点 agent tab 不会重连**：webview 只改本地选中态，不通知宿主，
   所以被 LRU 驱逐的 agent 永远回不来，用户的注意力也不参与 LRU 排序。
   现在 tab 点击发 `focusAgent`，宿主走 `attachAgent()`——已附着的只是 `touch()`，
   已驱逐的重新 `thread/resume`。`refocus` 场景同时确认了重连不会重放历史，
   所以 webview 不会出现重复气泡。

同时被实测确认成立的设计假设：`subAgentActivity` 成对出现（只处理 completed 一半是对的）、
子线程 `parentThreadId` 指回父线程、`canAcceptDirectInput === false`、
子 agent 有随机昵称、agent path 逐层拼接（`/root/researcher/scraper`）、
审批请求带正确的子线程归属、`thread/unsubscribe` 可用。

未覆盖：父线程 `historyMode: "paginated"` 与子线程 resume 的交互、
webview 侧的嵌套 tab 渲染（需要真机手测）。

---

## 6. 风险

| 风险 | 状态 | 影响 | 缓解 |
|---|---|---|---|
| `thread/resume` 对运行中 v2 子线程的行为 | 已实测通过（§5.2） | — | 只传 `threadId`、active-writer 回退、rollout 未落盘重试 |
| 用户落在非 v2 模型上 | 已处理 | 界面空白、以为坏了 | 三级探测 + 运行时一键启用（§3.7） |
| 实验字段随 codex 版本漂移 | 开放 | 编译或运行时失败 | 现有 `protocol-version.txt` 不一致告警 |
| 并发 agent 渲染性能 | 未压测 | 卡顿 | 订阅上限 8；需要时再加分片 + memo |
| LRU 驱逐丢失 transcript | 已知，影响下调 | 驱逐后的输出看不到 | 状态仍免订阅推送（§3.3），只丢 transcript；重新点开该 tab 时再附着 |
| 父线程 `historyMode: "paginated"` 与子线程 resume 的交互 | 开放 | 历史缺失或报错 | 待实测 |
| 全量自动批准（D-3）在并发 agent 下风险面放大 | 已知并接受 | 安全 | `AgentNode` 预留状态字段，改策略不需改模型 |
| v2 是引擎的在建方向，事件形状可能继续变 | 开放 | 返工 | 适配层集中在 `protocol/notifications.ts` 一处 |

---

## 7. 待确认

凭据问题已不成立——`npm run test:e2e` 不需要任何 key（§5.2）。剩下的是产品取舍：

1. **真机手测嵌套 tab**：逻辑层已有回归测试覆盖，但 webview 的实际观感
   （tab 拥挤程度、切换时的滚动位置、几十个 agent 时的横向溢出）只能人看。
   这是目前唯一真正需要人的一项。
2. **订阅上限 8 是否合适**：驱逐的代价现在是有界的——状态照常推送（§3.3），
   点回 tab 会自动重连（§5.1 偏差 3），所以这个数字可以偏保守。压测后再定。
3. **子 agent 的文件变更在 UI 上如何呈现**：数据层已并入根会话（§5.1 偏差 4），
   但界面上没有标明某处改动来自哪个 agent。要不要在文件行上加来源标记。
