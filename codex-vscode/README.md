# Codex for VS Code (app-server)

在 VS Code 里使用 Codex agent。前端是 React webview，后端直连本机 `codex app-server`
（JSON-RPC over stdio），不经过任何中间层。

## 前置条件

- 已安装 Codex CLI（`codex` 可执行文件）
- `~/.codex/config.toml` 中已配置可用的 `model_providers`
  - 若没有顶层 `model` / `model_provider`，扩展会自动使用第一个自定义 provider

## 开发

```bash
npm install
npm run build          # 构建 webview + 编译扩展
code .                 # 用 VS Code 打开本目录
```

然后按 **F5** 启动扩展宿主，在新窗口中执行 `Ctrl+Shift+P` → `Codex: Open Chat`。

开发时可用：

```bash
npm run watch          # 监听扩展端 TS
npm run watch:webview  # 监听 webview
```

## 打包

```bash
npm install -g @vscode/vsce   # 或用 npx
vsce package                  # 产出 codex-vscode-<version>.vsix
```

在 VS Code 中选择「从 VSIX 安装」即可使用。

## 配置项

| 配置 | 说明 |
|---|---|
| `codex.binPath` | codex 可执行文件路径，留空则自动探测（取最新的 `codex.exe`） |
| `codex.model` | 模型 id，留空则用 config.toml 的值 |
| `codex.modelProvider` | provider id，留空则用 config.toml 的值 |

## 功能

- 流式对话、Markdown 渲染、代码高亮
- 代码块一键复制 / 插入到编辑器
- 命令执行审批（允许一次 / 本会话允许 / 拒绝）
- 模型主动提问（`item/tool/requestUserInput`）的问答卡片
- 思考过程折叠展示
- 文件变更列表，支持 diff 查看与撤销
- 按轮次回滚（`thread/revert`）
- 中断进行中的回合（`turn/interrupt`）
- 历史会话恢复（`thread/resume`）
- 可用技能查看（`skills/list`）
- app-server 崩溃自动重连并恢复会话

## 实现要点

协议层的几个坑（已处理，改动时请勿回退）：

1. `thread/start` 必须传 `historyMode: "paginated"`，否则 `thread/revert` 会报
   `only supports paginated threads`。
2. `turn/start` 的审批决策值是 `acceptForSession` / `accept` / `decline`，
   **不是** v1 的 `approved`——用错会让回合永久挂起。
3. `turn/interrupt` 需要 `threadId` **和** `turnId` 两个字段。
4. `FileUpdateChange.kind` 是带 tag 的枚举对象（`{"type":"add"}`），不是字符串。
5. `thread/list` 对本地 app-server 客户端返回空，历史会话改为扫描
   `~/.codex/sessions/**/rollout-*.jsonl`。
6. 生成的协议类型（`src/generated`）与 codex 版本绑定，
   升级后需重新运行 `codex app-server generate-ts --out src/generated`
   并更新 `protocol-version.txt`。

## 已知限制

- 撤销改动依赖 git；非 git 仓库下只能查看协议自带的 diff 文本
- 历史会话通过扫描 rollout 文件实现，预览取首条用户消息尾部
- 单会话面板（多标签待实现）
