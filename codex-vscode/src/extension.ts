import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  AppServerClient,
  APPROVAL_DECISIONS,
  findCodexBin,
  type Notification,
  type ServerRequest,
} from './appServerClient';
import { AgentRegistry } from './agents/registry';
import { SubscriptionManager } from './agents/subscriptions';
import type { ThreadItem } from './generated/v2/ThreadItem';
import {
  detectMultiAgent,
  enableMultiAgentV2ForSession,
  type MultiAgentCapability,
} from './protocol/capabilities';
import { diffStat, patchChangeKind } from './protocol/items';
import { asServerNotification } from './protocol/notifications';
import { INITIAL_TURNS_PAGE, replayTurns, turnsToReplay } from './history/replay';

let client: AppServerClient | undefined;
let view: vscode.WebviewView | undefined;
let activeThreadId: string | undefined;
let autoApprove = true;
let restartAttempts = 0;
const MAX_RESTART = 3;
/** Defaults for newly created threads; changed from the model picker. */
let pendingModel = '';
let pendingProvider = '';
/** Extra env (API keys added at runtime) merged into the app-server process. */
const extraEnv: Record<string, string> = {};
const openSessions = new Map<string, { model: string; provider: string }>();
const sessionTitles = new Map<string, string>();
const turnIds = new Map<string, string>();
const fileChanges = new Map<string, Map<string, { path: string; kind: string; diff: string }>>();
const SESSION_STATE_KEY = 'codex.openSessions';
let extensionContext: vscode.ExtensionContext | undefined;
/** Multi-agent runtime resolved from the engine; drives the orchestration UI. */
let multiAgent: MultiAgentCapability | undefined;
const agents = new AgentRegistry();
let subscriptions: SubscriptionManager | undefined;

function configTomlPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function workspaceRoot(): string {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function resolveInWorkspace(p: string): string | undefined {
  const root = workspaceRoot();
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return undefined;
  }
  return abs;
}

function detectFromConfigToml(): { model: string; provider: string } {
  const out = { model: '', provider: '' };
  let text = '';
  try {
    text = fs.readFileSync(configTomlPath(), 'utf8');
  } catch {
    return out;
  }
  const builtin = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime']);
  const topModel = /^\s*model\s*=\s*"([^"]+)"/m.exec(text);
  const topProvider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(text);
  if (topModel) {
    out.model = topModel[1];
  }
  if (topProvider) {
    out.provider = topProvider[1];
  } else {
    for (const m of text.matchAll(/^\s*\[model_providers\.([^\]]+)\]/gm)) {
      if (!builtin.has(m[1])) {
        out.provider = m[1];
        break;
      }
    }
  }
  if (!out.model && out.provider) {
    try {
      const prof = fs.readFileSync(path.join(os.homedir(), '.codex', `${out.provider}.config.toml`), 'utf8');
      const pm = /^\s*model\s*=\s*"([^"]+)"/m.exec(prof);
      if (pm) {
        out.model = pm[1];
      }
    } catch {
      /* profile is optional */
    }
  }
  return out;
}

function post(msg: Record<string, unknown>) {
  void view?.webview.postMessage(msg);
}

/** Route a per-turn event to the tab it belongs to. */
function notifyThread(threadId: string | undefined, event: Record<string, unknown>) {
  post({ ...event, threadId: threadId ?? activeThreadId });
}

function decisionFor(method: string, kind: 'once' | 'session' | 'deny'): string {
  if (kind === 'deny') {
    return method.startsWith('item/') ? 'decline' : 'denied';
  }
  if (method.startsWith('item/')) {
    return kind === 'session' ? 'acceptForSession' : 'accept';
  }
  return 'approved';
}

async function handleServerRequest(req: ServerRequest) {
  if (!client) {
    return;
  }
  if (!APPROVAL_DECISIONS[req.method]) {
    client.respond(req.id, {});
    return;
  }
  const p = req.params ?? {};
  const what = Array.isArray(p.command)
    ? p.command.join(' ')
    : (p.command ?? p.reason ?? JSON.stringify(p).slice(0, 300));
  if (autoApprove) {
    client.respond(req.id, { decision: decisionFor(req.method, 'session') });
    post({ type: 'status', text: `自动批准: ${String(what).slice(0, 140)}` });
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Codex 请求批准\n\n${what}`,
    { modal: false },
    '允许一次',
    '本会话允许',
    '拒绝',
  );
  if (pick === '本会话允许') {
    client.respond(req.id, { decision: decisionFor(req.method, 'session') });
  } else if (pick === '允许一次') {
    client.respond(req.id, { decision: decisionFor(req.method, 'once') });
  } else {
    client.respond(req.id, { decision: decisionFor(req.method, 'deny') });
  }
}

function handleNotification(raw: Notification) {
  const n = asServerNotification(raw);
  switch (n.method) {
    case 'item/agentMessage/delta':
      notifyThread(n.params.threadId, { type: 'delta', text: n.params.delta });
      break;
    case 'item/reasoning/textDelta':
      notifyThread(n.params.threadId, { type: 'thinking', text: n.params.delta });
      break;
    case 'item/commandExecution/outputDelta':
      notifyThread(n.params.threadId, { type: 'tool', text: n.params.delta });
      break;
    case 'item/started':
      onItemStarted(n.params.threadId, n.params.item);
      break;
    case 'turn/started':
      // Sub-agent turns are started by the engine, so this is the only way to learn the
      // turn id needed to interrupt them.
      turnIds.set(n.params.threadId, n.params.turn.id);
      subscriptions?.touch(n.params.threadId);
      break;
    case 'item/completed':
      onItemCompleted(n.params.threadId, n.params.item);
      break;
    case 'turn/completed':
      turnIds.delete(n.params.threadId);
      notifyThread(n.params.threadId, { type: 'done', status: n.params.turn.status });
      notifyThread(n.params.threadId, { type: 'checkpoint', turnId: n.params.turn.id });
      break;
    case 'thread/status/changed':
      // Unlike `item/*`, this reaches the connection even for threads it never subscribed to,
      // so an agent that was evicted from the live set still reports accurate liveness.
      if (agents.applyStatus(n.params.threadId, n.params.status)) {
        postAgentTree(n.params.threadId);
      }
      break;
    case 'error':
      notifyThread(n.params.threadId, { type: 'error', text: n.params.error.message });
      break;
    default:
      break;
  }
}

function onItemStarted(threadId: string, item: ThreadItem) {
  switch (item.type) {
    case 'commandExecution':
      notifyThread(threadId, { type: 'tool', text: `\n$ ${item.command}\n` });
      break;
    default:
      break;
  }
}

function onItemCompleted(threadId: string, item: ThreadItem) {
  switch (item.type) {
    case 'commandExecution':
      notifyThread(threadId, {
        type: 'tool',
        text: item.exitCode === 0 ? '[ok]\n' : `[exit=${item.exitCode}]\n`,
      });
      break;
    case 'fileChange': {
      // Sub-agents edit the same workspace as their root session, so their changes are
      // recorded against the root. Diff and undo then cover the whole tree, no matter which
      // tab the user is looking at.
      const rootThreadId = agents.rootThreadIdFor(threadId);
      let changes = fileChanges.get(rootThreadId);
      if (!changes) {
        changes = new Map();
        fileChanges.set(rootThreadId, changes);
      }
      const items = item.changes.map((c) => {
        const kind = patchChangeKind(c);
        changes.set(c.path, { path: c.path, kind, diff: c.diff });
        return { path: c.path, kind, ...diffStat(c.diff) };
      });
      if (items.length) {
        notifyThread(threadId, { type: 'files', items });
      }
      break;
    }
    case 'subAgentActivity':
      // The engine emits this item as a started/completed pair back to back
      // (`emit_sub_agent_activity`), so handling only the completed half processes each
      // activity exactly once without losing any latency.
      if (agents.recordActivity(threadId, item)) {
        postAgentTree(threadId);
      }
      void attachAgent(item.agentThreadId);
      break;
    default:
      break;
  }
}

/**
 * Subscribes to a sub-agent thread so its own items stream in.
 *
 * Without this the extension only ever sees the parent's activity events, which carry a path
 * and a liveness hint but none of the agent's actual work.
 */
async function attachAgent(threadId: string) {
  const attached = await subscriptions?.attach(threadId);
  if (!attached) {
    return;
  }
  agents.applyThread(attached.thread, attached.attachment);
  postAgentTree(threadId);
}

/** Unsubscribes from every agent below a thread and forgets them. */
async function releaseAgentsUnder(rootThreadId: string) {
  const descendants = agents.descendantsOf(rootThreadId);
  await Promise.all(descendants.map((node) => subscriptions?.detach(node.threadId)));
  agents.removeTree(rootThreadId);
}

/**
 * Publishes the agent tree for the session that owns `threadId`.
 *
 * Agents belong to a thread, not to whichever tab happens to be focused. Deriving the root
 * from the thread the event came from also means a restored session publishes its agents
 * even before the user has touched a tab.
 */
function postAgentTree(threadId: string | undefined) {
  if (!threadId) {
    return;
  }
  const rootThreadId = agents.rootThreadIdFor(threadId);
  post({
    type: 'agentTree',
    rootThreadId,
    nodes: agents.descendantsOf(rootThreadId),
  });
}

// ---------------------------------------------------------------------------
// custom model registry + provider config
// ---------------------------------------------------------------------------
interface CustomModel {
  key: string;
  providerName: string;
  providerId: string;
  model: string;
  baseUrl: string;
}

function customModelsFile(): string {
  return path.join(os.homedir(), '.codex', 'codex-vscode-models.json');
}

function readCustomModels(): CustomModel[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(customModelsFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendProviderToConfig(id: string, name: string, baseUrl: string, envKey: string): boolean {
  let text = '';
  try {
    text = fs.readFileSync(configTomlPath(), 'utf8');
  } catch {
    /* new file is fine */
  }
  if (text.includes(`[model_providers.${id}]`)) {
    return false;
  }
  const block =
    `\n[model_providers.${id}]\n` +
    `name = "${name}"\n` +
    `base_url = "${baseUrl}"\n` +
    `env_key = "${envKey}"\n` +
    `wire_api = "responses"\n` +
    `requires_openai_auth = false\n` +
    `supports_websockets = false\n` +
    `supports_standalone_web_search = false\n`;
  fs.appendFileSync(configTomlPath(), block, 'utf8');
  return true;
}

/** Derive a provider id from a base URL's hostname (venus from v2.open.venus.woa.com). */
function providerIdFromUrl(url: string): string {
  try {
    const parts = new URL(url).hostname
      .split('.')
      .filter((p) => p && !/^\d+$/.test(p));
    const skip = new Set(['com', 'net', 'org', 'cn', 'io', 'ai', 'dev', 'cloud']);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!skip.has(parts[i])) {
        return parts[i];
      }
    }
    return parts[0] ?? 'custom';
  } catch {
    return 'custom';
  }
}

async function addModel(p: {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}): Promise<{ id: string; message: string }> {
  const providerName = providerIdFromUrl(p.baseUrl);
  const id =
    providerName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom';
  const envKey = `CODEX_${id.replace(/-/g, '_').toUpperCase()}_API_KEY`;
  const created = appendProviderToConfig(id, providerName, p.baseUrl, envKey);

  // Make the key visible to the app-server process and to future sessions.
  extraEnv[envKey] = p.apiKey;
  try {
    execSync(`setx ${envKey} ${JSON.stringify(p.apiKey)}`, { stdio: 'ignore' });
  } catch {
    /* setx is best-effort; the in-memory env already covers this session */
  }

  const list = readCustomModels().filter((m) => m.key !== `${id}/${p.modelName}`);
  list.push({
    key: `${id}/${p.modelName}`,
    providerName,
    providerId: id,
    model: p.modelName,
    baseUrl: p.baseUrl,
  });
  fs.writeFileSync(customModelsFile(), JSON.stringify(list, null, 2), 'utf8');

  // Restart the engine so the new provider/env actually load, then resume tabs.
  await restartForModels();
  return {
    id,
    message: created
      ? `已添加 ${p.modelName}（provider: ${id}）并重启引擎`
      : `Provider ${id} 已存在，已补充模型记录`,
  };
}

/** Restart app-server (to pick up new env/config) and resume every open tab. */
async function restartForModels() {
  client?.dispose();
  client = undefined;
  currentTurnCleanup();
  const c = await ensureClient();
  for (const tid of [...openSessions.keys()]) {
    try {
      await c.request('thread/resume', { threadId: tid }, 60_000);
    } catch {
      openSessions.delete(tid);
      post({ type: 'threadClosed', threadId: tid });
    }
  }
  post({ type: 'status', text: '引擎已重启，会话已恢复' });
}

function currentTurnCleanup() {
  turnIds.clear();
}

/** Providers already present in config.toml (e.g. hand-added venus). */
function detectConfigProviders(): CustomModel[] {
  const out: CustomModel[] = [];
  let text = '';
  try {
    text = fs.readFileSync(configTomlPath(), 'utf8');
  } catch {
    return out;
  }
  const builtin = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime']);
  for (const m of text.matchAll(/^\s*\[model_providers\.([^\]]+)\]/gm)) {
    const id = m[1];
    if (builtin.has(id)) {
      continue;
    }
    const start = m.index ?? 0;
    const rest = text.slice(start + 1);
    const nextIdx = rest.indexOf('\n[');
    const block = nextIdx > 0 ? rest.slice(0, nextIdx) : rest;
    const nm = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    const bu = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(block);
    let model = '';
    try {
      const prof = fs.readFileSync(path.join(os.homedir(), '.codex', `${id}.config.toml`), 'utf8');
      const pm = /^\s*model\s*=\s*"([^"]+)"/m.exec(prof);
      if (pm) {
        model = pm[1];
      }
    } catch {
      /* no profile - fall back to provider default model */
    }
    out.push({
      key: `${id}/${model || '(默认)'}`,
      providerName: nm ? nm[1] : id,
      providerId: id,
      model,
      baseUrl: bu ? bu[1] : '',
    });
  }
  return out;
}

function mergeModels(...lists: CustomModel[][]): CustomModel[] {
  const seen = new Set<string>();
  const out: CustomModel[] = [];
  for (const list of lists) {
    for (const m of list) {
      const k = `${m.providerId}/${m.model}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(m);
      }
    }
  }
  return out;
}

/**
 * Only user-added models are offered: the provider catalog is intentionally
 * not listed, so every entry in the picker comes from "Add Custom Model"
 * or from providers already configured in config.toml.
 */
async function listModels(): Promise<void> {
  post({
    type: 'models',
    builtin: [],
    custom: mergeModels(readCustomModels(), detectConfigProviders()),
    current: { model: pendingModel, provider: pendingProvider },
  });
}

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------
async function startThread() {
  const cfg = vscode.workspace.getConfiguration('codex');
  const detected = detectFromConfigToml();
  const model = pendingModel || cfg.get('model') || detected.model;
  const provider = pendingProvider || cfg.get('modelProvider') || detected.provider;
  const approvalPolicy: string = cfg.get('approvalPolicy') || 'on-request';
  const cwd = workspaceRoot();
  const res = await client!.request(
    'thread/start',
    {
      cwd,
      model: model || undefined,
      modelProvider: provider || undefined,
      // Required for thread/revert (Checkpoint/Undo); legacy threads reject it.
      historyMode: 'paginated',
      approvalPolicy,
    },
    60_000,
  );
  const tid = res?.thread?.id ?? res?.threadId;
  openSessions.set(tid, { model, provider });
  activeThreadId = tid;
  const title = 'New Chat';
  sessionTitles.set(tid, title);
  post({ type: 'threadOpened', threadId: tid, title, cwd, model, provider });
  persistSessions();
}

/** Render a thread's blocks as Markdown for export. */
function renderThreadMarkdown(
  title: string,
  blocks: Array<{ kind?: string; text?: string; paths?: string[] }>,
): string {
  const out: string[] = [`# ${title}`, ''];
  for (const b of blocks) {
    switch (b.kind) {
      case 'you':
        out.push('## 用户', '', b.text ?? '', '');
        break;
      case 'agent':
        out.push(b.text ?? '', '');
        break;
      case 'tool':
        out.push('```', b.text ?? '', '```', '');
        break;
      case 'thinking':
        out.push('<details><summary>思考过程</summary>', '', '```', b.text ?? '', '```', '', '</details>', '');
        break;
      case 'files':
        out.push(`**文件变更**：${(b.paths ?? []).join(', ')}`, '');
        break;
      case 'error':
        out.push(`> 错误：${b.text ?? ''}`, '');
        break;
      case 'status':
        out.push(`_${b.text ?? ''}_`, '');
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}

/** Default input box height in px (also applied from the host on startup). */
const DEFAULT_COMPOSER_HEIGHT = 104;

/** Titles that only mean "not named yet" and may be replaced automatically. */
const AUTO_TITLE_RE = /^(New Chat|会话\s*\d+|历史\s*\d+)$/;

/** Name a tab after its first real message (only while still auto-named). */
function autoTitle(threadId: string, text: string) {
  const cur = sessionTitles.get(threadId);
  if (cur && !AUTO_TITLE_RE.test(cur)) {
    return;
  }
  const title = text.replace(/\s+/g, ' ').slice(0, 24) || '会话';
  sessionTitles.set(threadId, title);
  post({ type: 'threadRenamed', threadId, title });
  persistSessions();
}

/** Remember open tabs so they survive panel close and VS Code restarts. */
function persistSessions() {
  if (!extensionContext) {
    return;
  }
  const data = [...openSessions.entries()].map(([threadId, info]) => ({
    threadId,
    title: sessionTitles.get(threadId) ?? '会话',
    model: info.model,
    provider: info.provider,
  }));
  void extensionContext.workspaceState.update(SESSION_STATE_KEY, data);
}

/**
 * Rebuild tabs: resume every remembered thread so reopening the panel (or
 * restarting VS Code) brings the conversation back instead of a blank view.
 */
async function restoreSessions(): Promise<boolean> {
  const saved = (extensionContext?.workspaceState.get<any[]>(SESSION_STATE_KEY) ?? []) as Array<{
    threadId: string;
    title: string;
    model: string;
    provider: string;
  }>;
  const wanted = new Map<string, { title: string; model: string; provider: string }>();
  for (const s of [...saved, ...[...openSessions.entries()].map(([threadId, i]) => ({
    threadId,
    title: sessionTitles.get(threadId) ?? '会话',
    model: i.model,
    provider: i.provider,
  }))]) {
    if (!wanted.has(s.threadId)) {
      wanted.set(s.threadId, { title: s.title, model: s.model, provider: s.provider });
    }
  }
  let restored = false;
  for (const [threadId, info] of wanted) {
    try {
      const res = await client!.request(
        'thread/resume',
        { threadId, initialTurnsPage: INITIAL_TURNS_PAGE },
        60_000,
      );
      openSessions.set(threadId, { model: info.model, provider: info.provider });
      sessionTitles.set(threadId, info.title);
      post({
        type: 'threadOpened',
        threadId,
        title: info.title,
        model: info.model,
        provider: info.provider,
      });
      replayThread(threadId, res);
      // The webview selects each tab as it opens, so the host has to track the same one.
      // Leaving this unset left the extension with no active thread at all after a restart.
      activeThreadId = threadId;
      restored = true;
    } catch {
      openSessions.delete(threadId);
      sessionTitles.delete(threadId);
    }
  }
  persistSessions();
  return restored;
}

/**
 * Puts a resumed thread's transcript back on screen.
 *
 * Without this a restart restores the tab but not the conversation, which reads as the
 * history having been lost. File changes are re-registered along the way so diff and undo
 * keep working on a thread the extension has only just re-learned about.
 */
function replayThread(threadId: string, resumeResponse: any): void {
  const turns = turnsToReplay(resumeResponse?.initialTurnsPage, resumeResponse?.thread?.turns);
  if (!turns.length) {
    return;
  }
  const rootThreadId = agents.rootThreadIdFor(threadId);
  let changes = fileChanges.get(rootThreadId);
  if (!changes) {
    changes = new Map();
    fileChanges.set(rootThreadId, changes);
  }
  const target = changes;
  replayTurns(turns, {
    emit: (message) => notifyThread(threadId, message),
    recordChange: (change) => target.set(change.path, change),
    changeKind: patchChangeKind,
    diffStat,
  });
}

/** Re-spawn app-server and resume the active thread after a crash. */
async function handleCrash() {
  if (!view) {
    return;
  }
  if (restartAttempts >= MAX_RESTART) {
    post({ type: 'error', text: 'app-server 反复崩溃，已停止自动重连。请重新打开面板。' });
    return;
  }
  restartAttempts++;
  post({ type: 'status', text: `app-server 断开，正在重连 (${restartAttempts}/${MAX_RESTART})…` });
  client = undefined;
  currentTurnCleanup();
  try {
    const c = await ensureClient();
    for (const tid of [...openSessions.keys()]) {
      try {
        await c.request('thread/resume', { threadId: tid }, 60_000);
      } catch {
        openSessions.delete(tid);
        post({ type: 'threadClosed', threadId: tid });
      }
    }
    post({ type: 'status', text: '已恢复所有会话' });
    restartAttempts = 0;
  } catch (err) {
    post({ type: 'error', text: `重连失败: ${String(err)}` });
  }
}

/** Version recorded when the protocol TS bindings were generated. */
function generatedProtocolVersion(): string {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'protocol-version.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function codexVersion(bin: string): string {
  try {
    const out = execSync(`"${bin}" --version`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(out);
    return m ? m[1] : out.trim();
  } catch {
    return '';
  }
}

async function ensureClient() {
  if (client) {
    return client;
  }
  const cfg = vscode.workspace.getConfiguration('codex');
  let bin: string = cfg.get('binPath') || '';
  if (!bin) {
    bin = findCodexBin();
  }
  if (!pendingModel || !pendingProvider) {
    const detected = detectFromConfigToml();
    pendingModel = pendingModel || cfg.get('model') || detected.model;
    pendingProvider = pendingProvider || cfg.get('modelProvider') || detected.provider;
  }
  const gen = generatedProtocolVersion();
  const cur = codexVersion(bin);
  if (gen && cur && gen !== cur) {
    post({
      type: 'status',
      text: `⚠ codex 版本 ${cur} 与生成的协议类型 ${gen} 不一致，建议重新运行 codex app-server generate-ts`,
    });
  }
  const c = new AppServerClient(bin, workspaceRoot(), extraEnv);
  c.onNotification = handleNotification;
  c.onServerRequest = (r) => {
    if (r.method === 'item/tool/requestUserInput') {
      notifyThread(r.params?.threadId, {
        type: 'ask',
        requestId: r.id,
        questions: r.params?.questions ?? [],
      });
      return;
    }
    void handleServerRequest(r);
  };
  c.onStderr = (s) => post({ type: 'status', text: s.slice(0, 200) });
  c.onExit = (code) => {
    post({ type: 'error', text: `app-server 退出 (code=${code})` });
    client = undefined;
    subscriptions = undefined;
    void handleCrash();
  };
  await c.request('initialize', {
    clientInfo: { name: 'codex-vscode', version: '0.3.0' },
    capabilities: { experimentalApi: true },
  });
  c.notify('initialized', {});
  client = c;
  subscriptions = new SubscriptionManager(
    (method, params, timeoutMs) => c.request(method, params, timeoutMs),
    (threadId) => {
      agents.setAttachment(threadId, 'detached');
      postAgentTree(threadId);
    },
  );
  return c;
}

async function showDiff(threadId: string, target: string) {
  const entry = fileChanges.get(agents.rootThreadIdFor(threadId))?.get(target);
  const abs = resolveInWorkspace(target);
  if (!entry || !abs) {
    return;
  }
  try {
    const rel = path.relative(workspaceRoot(), abs).replace(/\\/g, '/');
    const before = execSync(`git show HEAD:${JSON.stringify(rel)}`, {
      cwd: workspaceRoot(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const left = await vscode.workspace.openTextDocument({ content: before });
    const right = await vscode.workspace.openTextDocument(abs);
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${target} (改动前 ↔ 当前)`);
    return;
  } catch {
    /* fall through to raw diff */
  }
  const doc = await vscode.workspace.openTextDocument({ content: entry.diff, language: 'diff' });
  await vscode.window.showTextDocument(doc);
}

async function undoFiles(threadId: string, targets: string[]) {
  const root = workspaceRoot();
  const changes = fileChanges.get(agents.rootThreadIdFor(threadId));
  const tracked: string[] = [];
  const added: string[] = [];
  for (const t of targets) {
    const abs = resolveInWorkspace(t);
    if (!abs) {
      continue;
    }
    if (changes?.get(t)?.kind === 'add') {
      added.push(abs);
    } else {
      tracked.push(path.relative(root, abs).replace(/\\/g, '/'));
    }
  }
  for (const f of added) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      post({ type: 'error', text: `删除新增文件失败 ${f}: ${String(err)}` });
    }
  }
  if (tracked.length) {
    try {
      const arg = tracked.map((r) => JSON.stringify(r)).join(' ');
      execSync(`git checkout -- ${arg}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      post({ type: 'error', text: `撤销失败: ${String(err)}` });
    }
  }
  if (added.length || tracked.length) {
    post({ type: 'status', text: `已撤销 ${tracked.length} 个改动文件、${added.length} 个新增文件` });
  }
}

// ---------------------------------------------------------------------------
// session history (rollout scan; thread/list is empty for local clients)
// ---------------------------------------------------------------------------
export interface SessionSummary {
  threadId: string;
  startedAt: string;
  preview: string;
}

function listSessions(limit = 40): SessionSummary[] {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const out: SessionSummary[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const m = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/.exec(e.name);
      if (!m) {
        continue;
      }
      out.push({
        threadId: m[5],
        startedAt: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`,
        preview: firstUserMessage(full),
      });
    }
  };
  walk(root);
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out.slice(0, limit);
}

/** Engine-injected context, not real user input. */
const SYSTEM_MSG_MARKERS = [
  '<environment_context>',
  '<permission_profile>',
  '<user_instructions>',
  '<turn_context>',
  'AGENTS.md instructions',
  '<INSTRUCTIONS>',
];

function looksLikeSystemText(t: string): boolean {
  const s = t.trimStart();
  return s.startsWith('<') || SYSTEM_MSG_MARKERS.some((m) => s.includes(m));
}

/** Locate the rollout file backing a thread so it can be removed. */
function rolloutPathFor(threadId: string): string | undefined {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  let found: string | undefined;
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.includes(threadId) && e.name.endsWith('.jsonl')) {
        found = full;
      }
    }
  };
  walk(root);
  return found;
}

/** Delete a thread from the engine and drop its persisted rollout. */
async function deleteSession(threadId: string): Promise<boolean> {
  let ok = false;
  if (client) {
    try {
      await client.request('thread/delete', { threadId }, 30_000);
      ok = true;
    } catch {
      /* engine may not have it loaded - fall back to deleting the file */
    }
  }
  const f = rolloutPathFor(threadId);
  if (f) {
    try {
      fs.unlinkSync(f);
      ok = true;
    } catch {
      /* ignore */
    }
  }
  openSessions.delete(threadId);
  sessionTitles.delete(threadId);
  turnIds.delete(threadId);
  fileChanges.delete(threadId);
  if (activeThreadId === threadId) {
    activeThreadId = undefined;
  }
  post({ type: 'threadClosed', threadId });
  persistSessions();
  return ok;
}

function firstUserMessage(file: string): string {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 200);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = obj?.payload ?? obj;
      if (payload?.type !== 'message' || payload?.role !== 'user') {
        continue;
      }
      const content = payload?.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string') {
            texts.push(c.text);
          }
        }
      }
      // Skip environment/permission/instruction injections; show the real prompt.
      for (const t of texts) {
        const clean = t.replace(/\s+/g, ' ').trim();
        if (!clean || looksLikeSystemText(clean)) {
          continue;
        }
        return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function listSkills(): Promise<Array<{ name: string; description: string; enabled: boolean; scope: string }>> {
  if (!client) {
    return [];
  }
  try {
    const res = await client.request('skills/list', {}, 30_000);
    const out: Array<{ name: string; description: string; enabled: boolean; scope: string }> = [];
    for (const entry of (res?.data ?? []) as Array<{ skills?: any[] }>) {
      for (const s of entry.skills ?? []) {
        out.push({
          name: String(s?.name ?? ''),
          description: String(s?.description ?? s?.shortDescription ?? ''),
          enabled: Boolean(s?.enabled),
          scope: String(s?.scope ?? ''),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// webview
// ---------------------------------------------------------------------------
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function renderHtml(wv: vscode.Webview): string {
  if (!extensionContext) {
    return '<html><body><p>扩展尚未初始化。</p></body></html>';
  }
  const dist = path.join(extensionContext.extensionPath, 'webview', 'dist');
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) {
    return '<html><body><p>Webview 未构建。请先运行 <code>npm run build:webview</code>。</p></body></html>';
  }
  const nonce = getNonce();
  let html = fs.readFileSync(index, 'utf8');
  html = html.replace(/ crossorigin/g, '');
  html = html.replace(/(src|href)="([^"]+)"/g, (_m, attr: string, url: string) => {
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) {
      return `${attr}="${url}"`;
    }
    const file = vscode.Uri.file(path.join(dist, url.replace(/^\.?\//, '')));
    return `${attr}="${wv.asWebviewUri(file)}"`;
  });
  const csp = [
    "default-src 'none'",
    `img-src ${wv.cspSource} data:`,
    `style-src ${wv.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${wv.cspSource}`,
  ].join('; ');
  return html
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace(/<script /g, `<script nonce="${nonce}" `);
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexChat', new CodexViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codex.open', () => {
      void vscode.commands.executeCommand('codexChat.focus');
    }),
    vscode.commands.registerCommand('codex.newThread', () => {
      if (view) {
        void startThread();
      } else {
        void vscode.commands.executeCommand('codexChat.focus');
      }
    }),
    vscode.commands.registerCommand('codex.settings', () => {
      if (!view) {
        void vscode.commands.executeCommand('codexChat.focus');
      }
      // Open the in-panel settings page (history tab by default).
      post({ type: 'showPanel', panel: 'history' });
      post({ type: 'sessions', items: listSessions() });
    }),
  );
}

/**
 * Move the view to the secondary (right) side bar on first open, matching the
 * common chat-panel placement. Runs once; afterwards the user's manual layout
 * wins. Disable with codex.preferSecondarySideBar = false.
 */
async function ensurePreferredLocation(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  if (extensionContext.globalState.get('codex.onSecondarySideBar')) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('codex');
  if (cfg.get('preferSecondarySideBar') === false) {
    return;
  }
  try {
    await vscode.commands.executeCommand('codexChat.focus');
    await vscode.commands.executeCommand('workbench.action.moveViewToSecondarySideBar');
  } catch {
    /* layout commands can vary across versions - placement stays manual */
  }
  void extensionContext.globalState.update('codex.onSecondarySideBar', true);
}

class CodexViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionContext!.extensionPath, 'webview', 'dist')),
      ],
    };
    webviewView.webview.html = renderHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      if (view === webviewView) {
        view = undefined;
      }
    });
    webviewView.webview.onDidReceiveMessage((msg) => {
      void handleMessage(msg);
    });
    void bootstrap();
    void ensurePreferredLocation();
  }
}

async function bootstrap() {
  try {
    await ensureClient();
    const restored = await restoreSessions();
    if (!restored) {
      await startThread();
    }
    await probeMultiAgent();
  } catch (err) {
    post({ type: 'error', text: String(err) });
  }
}

/**
 * Report which multi-agent runtime the engine will use.
 *
 * The orchestration UI is built on v2 events, so the webview needs to tell apart
 * "no agents were spawned" from "v2 is not active and no agent events will ever arrive".
 */
async function probeMultiAgent() {
  if (!client) {
    return;
  }
  // The model the session actually runs decides whether nested spawning is available;
  // `pendingModel` is only the picker's default and is empty when config.toml supplies it.
  const model = openSessions.get(activeThreadId ?? '')?.model || pendingModel;
  const capability = await detectMultiAgent(
    (method, params, timeoutMs) => client!.request(method, params, timeoutMs),
    model,
  );
  multiAgent = capability;
  post({ type: 'multiAgent', ...capability });
}

async function handleMessage(msg: any) {
  switch (msg?.type) {
        case 'send': {
          const threadId = String(msg.threadId ?? '');
          const text = String(msg.text ?? '').trim();
          if (!text || !threadId || !client) {
            return;
          }
          notifyThread(threadId, { type: 'you', text });
          autoTitle(threadId, text);
          try {
            const res = await client.request('turn/start', {
              threadId,
              input: [{ type: 'text', text, textElements: [] }],
            }, 180_000);
            turnIds.set(threadId, res?.turn?.id);
          } catch (err) {
            notifyThread(threadId, { type: 'error', text: String(err) });
          }
          break;
        }
        case 'newThread':
          try {
            await startThread();
          } catch (err) {
            post({ type: 'error', text: String(err) });
          }
          break;
        case 'enableMultiAgentV2': {
          if (!client || multiAgent?.version === 'v2') {
            return;
          }
          const ok = await enableMultiAgentV2ForSession((method, params, timeoutMs) =>
            client!.request(method, params, timeoutMs),
          );
          post({
            type: 'status',
            text: ok
              ? '已为当前 app-server 进程启用 multi-agent v2，下一轮对话生效'
              : '启用 multi-agent v2 失败，请在 config.toml 中设置 features.multi_agent_v2 = true',
          });
          await probeMultiAgent();
          break;
        }
        case 'switchThread':
          activeThreadId = String(msg.threadId ?? '') || undefined;
          postAgentTree(activeThreadId);
          break;
        case 'closeThread': {
          const tid = String(msg.threadId ?? '');
          openSessions.delete(tid);
          turnIds.delete(tid);
          fileChanges.delete(tid);
          sessionTitles.delete(tid);
          await releaseAgentsUnder(tid);
          if (activeThreadId === tid) {
            activeThreadId = undefined;
          }
          persistSessions();
          break;
        }
        case 'interrupt': {
          const tid = String(msg.threadId ?? '');
          const turnId = turnIds.get(tid);
          if (tid && turnId && client) {
            try {
              await client.request('turn/interrupt', { threadId: tid, turnId }, 30_000);
            } catch (err) {
              notifyThread(tid, { type: 'error', text: `中断失败: ${String(err)}` });
            }
          }
          break;
        }
        case 'answer':
          client?.respond(msg.requestId, { answers: msg.answers ?? {} });
          break;
        case 'insertCode': {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            void editor.edit((b) => b.insert(editor.selection.active, String(msg.code ?? '')));
          }
          break;
        }
        case 'focusAgent': {
          // Selecting an agent's tab re-subscribes it if it was evicted, and otherwise just
          // marks it most recently used so the tab being watched is the last one dropped.
          const tid = String(msg.threadId ?? '');
          if (tid) {
            await attachAgent(tid);
          }
          break;
        }
        case 'openPath': {
          const target = String(msg.path ?? '');
          if (target) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
          }
          break;
        }
        case 'openFile': {
          const abs = resolveInWorkspace(String(msg.path ?? ''));
          if (abs) {
            try {
              const doc = await vscode.workspace.openTextDocument(abs);
              await vscode.window.showTextDocument(doc);
            } catch (err) {
              post({ type: 'error', text: String(err) });
            }
          }
          break;
        }
        case 'viewDiff':
          await showDiff(String(msg.threadId ?? ''), String(msg.path ?? ''));
          break;
        case 'undoFiles':
          await undoFiles(String(msg.threadId ?? ''), Array.isArray(msg.paths) ? msg.paths.map(String) : []);
          break;
        case 'revert': {
          const tid = String(msg.threadId ?? '');
          if (tid && client) {
            try {
              await client.request('thread/revert', { threadId: tid, beforeTurnId: String(msg.turnId ?? '') }, 60_000);
              fileChanges.delete(tid);
              notifyThread(tid, { type: 'clear' });
              post({ type: 'status', text: '已回滚到该轮之前' });
            } catch (err) {
              notifyThread(tid, { type: 'error', text: `回滚失败: ${String(err)}` });
            }
          }
          break;
        }
        case 'resumeSession': {
          if (client && msg.threadId) {
            try {
              const tid = String(msg.threadId);
              await client.request('thread/resume', { threadId: tid }, 60_000);
              if (!openSessions.has(tid)) {
                const s = openSessions.get(activeThreadId ?? '') ?? { model: pendingModel, provider: pendingProvider };
                openSessions.set(tid, s);
              }
              activeThreadId = tid;
              // Restored sessions keep a meaningful name from their first prompt.
              const prior = listSessions(1000).find((s) => s.threadId === tid);
              const title = prior?.preview ? prior.preview.slice(0, 24) : 'New Chat';
              sessionTitles.set(tid, title);
              post({
                type: 'threadOpened',
                threadId: tid,
                title,
                model: openSessions.get(tid)?.model ?? '',
                provider: openSessions.get(tid)?.provider ?? '',
              });
              persistSessions();
              post({ type: 'status', text: '已恢复历史会话' });
            } catch (err) {
              post({ type: 'error', text: `恢复会话失败: ${String(err)}` });
            }
          }
          break;
        }
        case 'listSessions':
          post({ type: 'sessions', items: listSessions() });
          break;
        case 'deleteSession': {
          const tid = String(msg.threadId ?? '');
          if (tid) {
            const ok = await deleteSession(tid);
            post({ type: 'sessions', items: listSessions() });
            post({ type: 'status', text: ok ? '已删除该会话' : '删除失败（可能已被清理）' });
          }
          break;
        }
        case 'deleteAllSessions': {
          const items = listSessions(1000);
          const answer = await vscode.window.showWarningMessage(
            `确定删除全部 ${items.length} 条历史会话？此操作不可撤销。`,
            { modal: true },
            '删除全部',
          );
          if (answer !== '删除全部') {
            break;
          }
          for (const s of items) {
            await deleteSession(s.threadId);
          }
          post({ type: 'sessions', items: listSessions() });
          post({ type: 'status', text: `已删除 ${items.length} 条历史会话` });
          break;
        }
        case 'listSkills':
          post({ type: 'skills', items: await listSkills() });
          break;
        case 'uiReady': {
          // Always reply: an explicit inline height beats any cached stylesheet.
          const saved = extensionContext?.workspaceState.get<number>('codex.composerHeight');
          const h = typeof saved === 'number' && saved >= 52 ? saved : DEFAULT_COMPOSER_HEIGHT;
          post({ type: 'composerHeight', height: h });
          break;
        }
        case 'saveComposerHeight': {
          const h = Number(msg.height);
          if (h >= 52) {
            void extensionContext?.workspaceState.update('codex.composerHeight', h);
          }
          break;
        }
        case 'renameThread': {
          const tid = String(msg.threadId ?? '');
          const title = String(msg.title ?? '').trim();
          if (tid && title) {
            sessionTitles.set(tid, title);
            persistSessions();
          }
          break;
        }
        case 'exportThread': {
          const title = String(msg.title ?? 'codex');
          const md = renderThreadMarkdown(title, Array.isArray(msg.blocks) ? msg.blocks : []);
          const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || 'codex-session';
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(workspaceRoot(), `${safe}.md`)),
            filters: { Markdown: ['md'] },
          });
          if (uri) {
            fs.writeFileSync(uri.fsPath, md, 'utf8');
            post({ type: 'status', text: `已导出到 ${uri.fsPath}` });
          }
          break;
        }
        case 'setAutoApprove':
          autoApprove = Boolean(msg.value);
          post({ type: 'status', text: autoApprove ? '已开启自动批准' : '已关闭自动批准' });
          break;
        case 'listModels':
          await listModels();
          break;
        case 'selectModel': {
          pendingModel = String(msg.model ?? '');
          pendingProvider = String(msg.provider ?? '');
          if (activeThreadId && client) {
            try {
              await client.request('thread/settings/update', {
                threadId: activeThreadId,
                model: pendingModel || undefined,
                modelProvider: pendingProvider || undefined,
              }, 30_000);
              const s = openSessions.get(activeThreadId);
              if (s) {
                s.model = pendingModel;
                s.provider = pendingProvider;
              }
              post({ type: 'status', text: `模型已切换为 ${pendingModel || '(默认)'}，下一轮生效` });
            } catch {
              post({ type: 'status', text: `新模型 ${pendingModel || '(默认)'} 将用于新建会话` });
            }
          }
          post({ type: 'modelChanged', model: pendingModel, provider: pendingProvider });
          break;
        }
        case 'addModel': {
          try {
            const { id, message } = await addModel({
              baseUrl: String(msg.baseUrl ?? ''),
              apiKey: String(msg.apiKey ?? ''),
              modelName: String(msg.modelName ?? ''),
            });
            pendingModel = String(msg.modelName ?? '');
            pendingProvider = id;
            post({ type: 'modelChanged', model: pendingModel, provider: pendingProvider });
            post({ type: 'status', text: message });
          } catch (err) {
            post({ type: 'error', text: `添加模型失败: ${String(err)}` });
          }
          break;
        }
        case 'openConfig': {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configTomlPath()));
            await vscode.window.showTextDocument(doc);
          } catch (err) {
            post({ type: 'error', text: String(err) });
          }
          break;
        }
        default:
          break;
      }
}

export function deactivate() {
  client?.dispose();
  client = undefined;
}
