import { useCallback, useEffect, useRef, useState } from 'react';
import {
  post,
  type Block,
  type BlockInput,
  type HostMessage,
  type SessionSummary,
  type SkillSummary,
  type CustomModel,
  type AgentInfo,
  type AgentStatus,
  type MultiAgentVersion,
} from './vscodeApi';
import { Markdown } from './Markdown';
import { AskCard } from './AskCard';
import { ModelPanel } from './ModelPanel';

interface Tab {
  threadId: string;
  title: string;
  blocks: Block[];
  busy: boolean;
  cwd?: string;
  model?: string;
  provider?: string;
}

type PanelView = 'none' | 'settings' | 'models';

/** Outcome of switching the engine to multi-agent v2, which this view requires. */
interface MultiAgentState {
  active: boolean;
  modelDeclaredVersion: MultiAgentVersion | null;
  nestedSpawnSupported: boolean;
}

const KIND_LABEL: Record<string, string> = {
  add: 'Add',
  update: 'Modify',
  delete: 'Delete',
};

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: '运行中',
  completed: '完成',
  interrupted: '已中断',
  unknown: '未知',
};

/** Prefers the nickname the engine assigned, falling back to the last path segment. */
function agentLabel(agent: AgentInfo): string {
  if (agent.nickname) {
    return agent.nickname;
  }
  const leaf = agent.agentPath.split('/').filter(Boolean).pop();
  return leaf ?? '子任务';
}

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState('');
  const [inputText, setInputText] = useState('');
  const [panelView, setPanelView] = useState<PanelView>('none');
  const [settingsTab, setSettingsTab] = useState<'history' | 'skills'>('history');
  const [editingId, setEditingId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [models, setModels] = useState<{
    builtin: { id: string; name: string }[];
    custom: CustomModel[];
    current: { model: string; provider: string };
  }>({ builtin: [], custom: [], current: { model: '', provider: '' } });
  /** Sub-agents of the active thread; the extension host owns this tree. */
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** Transcripts of sub-agent threads, keyed by agent thread id. */
  const [agentBlocks, setAgentBlocks] = useState<Record<string, Block[]>>({});
  /** Selected nested tab; empty means the parent thread itself. */
  const [activeAgentId, setActiveAgentId] = useState('');
  const [multiAgent, setMultiAgent] = useState<MultiAgentState | null>(null);
  const seq = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Agent thread ids, kept in a ref so block routing stays synchronous.
   *
   * The host always publishes the agent tree before it subscribes to an agent's thread, so
   * by the time that agent's items arrive its id is already here.
   */
  const agentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    agentIdsRef.current = new Set(agents.map((a) => a.threadId));
  }, [agents]);

  const nextId = () => `b${++seq.current}`;

  const updateTab = useCallback((threadId: string, fn: (t: Tab) => Tab) => {
    setTabs((ts) => ts.map((t) => (t.threadId === threadId ? fn(t) : t)));
  }, []);

  /** Applies a transcript edit to whichever thread owns it, parent or sub-agent. */
  const mutateBlocks = useCallback(
    (threadId: string, fn: (blocks: Block[]) => Block[]) => {
      if (agentIdsRef.current.has(threadId)) {
        setAgentBlocks((prev) => ({ ...prev, [threadId]: fn(prev[threadId] ?? []) }));
        return;
      }
      updateTab(threadId, (t) => ({ ...t, blocks: fn(t.blocks) }));
    },
    [updateTab],
  );

  const appendTo = useCallback(
    (threadId: string | undefined, kind: 'agent' | 'tool' | 'thinking', text: string) => {
      const tid = threadId || activeId;
      if (!tid) {
        return;
      }
      mutateBlocks(tid, (prev) => {
        const blocks = [...prev];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === kind) {
          blocks[blocks.length - 1] = { ...last, text: last.text + text } as Block;
        } else {
          blocks.push({ id: nextId(), kind, text } as Block);
        }
        return blocks;
      });
    },
    [activeId, mutateBlocks],
  );

  const pushBlock = useCallback(
    (threadId: string | undefined, block: BlockInput) => {
      const tid = threadId || activeId;
      if (!tid) {
        return;
      }
      mutateBlocks(tid, (prev) => [...prev, { ...block, id: nextId() } as Block]);
    },
    [activeId, mutateBlocks],
  );

  useEffect(() => {
    const onMsg = (e: MessageEvent<HostMessage>) => {
      const m = e.data;
      switch (m.type) {
        case 'threadOpened':
          setTabs((ts) => [
            ...ts,
            {
              threadId: m.threadId,
              title: m.title,
              blocks: [],
              busy: false,
              cwd: m.cwd,
              model: m.model,
              provider: m.provider,
            },
          ]);
          setActiveId(m.threadId);
          break;
        case 'threadClosed':
          setTabs((ts) => ts.filter((t) => t.threadId !== m.threadId));
          setAgents([]);
          setAgentBlocks({});
          setActiveAgentId('');
          break;
        case 'threadRenamed':
          updateTab(m.threadId, (t) => ({ ...t, title: m.title }));
          break;
        case 'delta':
          appendTo(m.threadId, 'agent', m.text);
          break;
        case 'thinking':
          appendTo(m.threadId, 'thinking', m.text);
          break;
        case 'tool':
          appendTo(m.threadId, 'tool', m.text);
          break;
        case 'you':
          pushBlock(m.threadId, { kind: 'you', text: m.text });
          break;
        case 'files':
          pushBlock(m.threadId, { kind: 'files', items: m.items });
          break;
        case 'multiAgent':
          setMultiAgent({
            active: m.active,
            modelDeclaredVersion: m.modelDeclaredVersion,
            nestedSpawnSupported: m.nestedSpawnSupported,
          });
          break;
        case 'agentTree':
          setAgents(m.nodes);
          setActiveAgentId((cur) =>
            cur && !m.nodes.some((n) => n.threadId === cur) ? '' : cur,
          );
          if (m.nodes.length) {
            ensureAgentsBlock(m.rootThreadId);
          }
          break;
        case 'ask':
          pushBlock(m.threadId, { kind: 'ask', requestId: m.requestId, questions: m.questions });
          break;
        case 'status':
          break;
        case 'done':
          updateTab(m.threadId || activeId, (t) => ({ ...t, busy: false }));
          break;
        case 'checkpoint':
          pushBlock(m.threadId, { kind: 'checkpoint', turnId: m.turnId });
          break;
        case 'error':
          pushBlock(m.threadId, { kind: 'error', text: m.text });
          updateTab(m.threadId || activeId, (t) => ({ ...t, busy: false }));
          break;
        case 'clear':
          updateTab(m.threadId || activeId, (t) => ({ ...t, blocks: [] }));
          break;
        case 'sessions':
          setSessions(m.items ?? []);
          break;
        case 'skills':
          setSkills(m.items ?? []);
          break;
        case 'models':
          setModels({ builtin: m.builtin ?? [], custom: m.custom ?? [], current: m.current });
          break;
        case 'modelChanged':
          setModels((prev) => ({ ...prev, current: { model: m.model, provider: m.provider } }));
          updateTab(activeId, (t) => ({ ...t, model: m.model, provider: m.provider }));
          break;
        case 'showPanel':
          setPanelView('settings');
          setSettingsTab(m.panel);
          break;
        case 'composerHeight': {
          const el = taRef.current;
          const h = Number(m.height);
          if (el && h >= 52) {
            el.style.height = `${h}px`;
          }
          break;
        }
        case 'doExport':
          exportCurrent();
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [appendTo, pushBlock, updateTab, activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [tabs, activeId, agentBlocks, activeAgentId]);

  // Ask the host for the persisted composer height.
  useEffect(() => {
    post({ type: 'uiReady' });
  }, []);

  // The sidebar pane body may add its own padding; measure the real offset
  // once and cancel it so tabs/content align flush with the panel edge.
  useEffect(() => {
    const app = document.querySelector('.app') as HTMLElement | null;
    if (!app) {
      return;
    }
    const left = app.getBoundingClientRect().left;
    if (left > 0.5) {
      app.style.marginLeft = `-${left}px`;
      app.style.width = `calc(100% + ${left}px)`;
    }
  }, []);

  const active = tabs.find((t) => t.threadId === activeId);

  const send = () => {
    const t = inputText.trim();
    if (!t || !activeId || active?.busy) {
      return;
    }
    setInputText('');
    updateTab(activeId, (tab) => ({ ...tab, busy: true }));
    post({ type: 'send', threadId: activeId, text: t });
  };

  const closeTab = (threadId: string) => {
    post({ type: 'closeThread', threadId });
    setTabs((ts) => ts.filter((t) => t.threadId !== threadId));
    setAgents([]);
    setAgentBlocks({});
    setActiveAgentId('');
    if (activeId === threadId) {
      const rest = tabs.filter((t) => t.threadId !== threadId);
      setActiveId(rest.length ? rest[rest.length - 1].threadId : '');
    }
  };

  /** One agents block per tab; it renders whatever agents belong to that tab. */
  const ensureAgentsBlock = useCallback((parent: string) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.threadId !== parent || t.blocks.some((b) => b.kind === 'agents')) {
          return t;
        }
        return { ...t, blocks: [...t.blocks, { id: nextId(), kind: 'agents' } as Block] };
      }),
    );
  }, []);

  // Without v2 no agent activity ever arrives, so the block that carries the warning has
  // to be created from the capability report rather than from the agent tree.
  useEffect(() => {
    if (activeId && multiAgent && !multiAgent.active) {
      ensureAgentsBlock(activeId);
    }
  }, [activeId, multiAgent, ensureAgentsBlock]);

  const commitRename = (threadId: string) => {
    const title = editTitle.trim();
    if (title) {
      updateTab(threadId, (t) => ({ ...t, title }));
      post({ type: 'renameThread', threadId, title });
    }
    setEditingId('');
  };

  const exportCurrent = () => {
    if (!active) {
      return;
    }
    post({
      type: 'exportThread',
      threadId: active.threadId,
      title: active.title,
      blocks: active.blocks.map((b) => ({
        kind: b.kind,
        text: 'text' in b ? b.text : '',
        paths: 'paths' in b ? b.paths : undefined,
      })),
    });
  };

  const togglePanel = (view: PanelView) => {
    if (panelView === view) {
      setPanelView('none');
      return;
    }
    setPanelView(view);
    if (view === 'models') {
      post({ type: 'listModels' });
    }
  };

  const openSettings = (tab: 'history' | 'skills') => {
    setPanelView('settings');
    setSettingsTab(tab);
    post({ type: tab === 'history' ? 'listSessions' : 'listSkills' });
  };

  const renderBlock = (b: Block) => {
    switch (b.kind) {
      case 'status':
        return (
          <div key={b.id} className="status">
            {b.text}
          </div>
        );
      case 'you':
        return (
          <div key={b.id} className="you">
            {b.text}
          </div>
        );
      case 'agent':
        return <Markdown key={b.id} text={b.text} />;
      case 'tool':
        return (
          <pre key={b.id} className="tool">
            {b.text}
          </pre>
        );
      case 'thinking':
        return (
          <details key={b.id} className="thinking">
            <summary>Deep Thinking</summary>
            <pre>{b.text}</pre>
          </details>
        );
      case 'files':
        return (
          <div key={b.id} className="fc-card">
            {b.items.map((it) => (
              <div key={it.path} className="fc-row">
                <button className="fc-main" onClick={() => post({ type: 'openFile', path: it.path })}>
                  <span className="fc-path">{baseName(it.path)}</span>
                  <span className={`fc-kind k-${it.kind}`}>({KIND_LABEL[it.kind] ?? it.kind})</span>
                  <span className="fc-stat">
                    <span className="add">+{it.added}</span> <span className="del">-{it.removed}</span>
                  </span>
                </button>
                <button
                  className="fc-diff"
                  onClick={() => post({ type: 'viewDiff', threadId: activeId, path: it.path })}
                >
                  View Diff
                </button>
              </div>
            ))}
            <div className="fc-footer">
              <button
                onClick={() => post({ type: 'undoFiles', threadId: activeId, paths: b.items.map((i) => i.path) })}
              >
                Undo
              </button>
            </div>
          </div>
        );
      case 'agents': {
        // This has to win over the empty check: without v2 no agent ever arrives, and
        // returning null would leave the panel silently blank.
        if (multiAgent && !multiAgent.active) {
          return (
            <div key={b.id} className="agent-list">
              <div className="agent-notice">
                <div>
                  无法启用 multi-agent v2，子 agent 不会出现。
                  请在 config.toml 中设置 features.multi_agent_v2 = true，或升级 codex。
                </div>
              </div>
            </div>
          );
        }
        if (agents.length === 0) {
          return null;
        }
        return (
          <div key={b.id} className="agent-list">
            <div className="agent-list-title">子 Agent（{agents.length}）</div>
            {multiAgent && !multiAgent.nestedSpawnSupported ? (
              <div className="agent-notice">
                <div>
                  当前模型未声明 v2，子 agent 无法再往下派发任务，编排只有一层。
                  换成声明 v2 的模型可恢复多层。
                </div>
              </div>
            ) : null}
            {agents.map((a) => (
              <div key={a.threadId} className="agent-card">
                <div className="agent-head">
                  <span className={`agent-status s-${a.status}`}>
                    {AGENT_STATUS_LABEL[a.status] ?? a.status}
                  </span>
                  <span className="agent-prompt">{agentLabel(a)}</span>
                </div>
                <div className="agent-meta">
                  <span className="agent-path">{a.agentPath || a.threadId.slice(0, 8)}</span>
                  {a.role ? <span>{a.role}</span> : null}
                  {a.attachment === 'readOnly' ? <span>只读</span> : null}
                  {a.attachment === 'detached' ? <span>未连接</span> : null}
                </div>
              </div>
            ))}
          </div>
        );
      }
      case 'ask':
        return <AskCard key={b.id} requestId={b.requestId} questions={b.questions} />;
      case 'checkpoint':
        return (
          <div key={b.id} className="checkpoint">
            <button onClick={() => post({ type: 'revert', threadId: activeId, turnId: b.turnId })}>
              ↩ 回滚到此轮之前
            </button>
          </div>
        );
      case 'error':
        return (
          <div key={b.id} className="error">
            {b.text}
          </div>
        );
      default:
        return null;
    }
  };

  const modelLabel = active?.model || models.current.model || '默认模型';
  const visibleBlocks = activeAgentId ? (agentBlocks[activeAgentId] ?? []) : (active?.blocks ?? []);
  const activeAgent = activeAgentId ? agents.find((a) => a.threadId === activeAgentId) : undefined;

  return (
    <div className="app">
      {tabs.length > 0 ? (
      <div className="titlebar">
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.threadId}
              className={'tab' + (t.threadId === activeId ? ' active' : '')}
              onClick={() => {
                setActiveId(t.threadId);
                setActiveAgentId('');
                post({ type: 'switchThread', threadId: t.threadId });
              }}
            >
              {editingId === t.threadId ? (
                <input
                  className="tab-edit"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commitRename(t.threadId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitRename(t.threadId);
                    } else if (e.key === 'Escape') {
                      setEditingId('');
                    }
                  }}
                />
              ) : (
                <span
                  className="tab-title"
                  title="双击可重命名"
                  onDoubleClick={() => {
                    setEditingId(t.threadId);
                    setEditTitle(t.title);
                  }}
                >
                  {t.title}
                  {t.busy ? ' ⏳' : ''}
                </span>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.threadId);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      ) : null}

      {panelView === 'settings' ? (
        <div className="overlay settings-page">
          <div className="settings-nav">
            <button
              className={'nav-item' + (settingsTab === 'history' ? ' active' : '')}
              onClick={() => openSettings('history')}
            >
              历史会话
            </button>
            <button
              className={'nav-item' + (settingsTab === 'skills' ? ' active' : '')}
              onClick={() => openSettings('skills')}
            >
              技能
            </button>
            <div className="nav-spacer" />
            <button className="icon-btn" title="关闭" onClick={() => setPanelView('none')}>
              ✕
            </button>
          </div>
          <div className="overlay-body">
            {settingsTab === 'history' ? (
              sessions.length === 0 ? (
                <div className="dim">（暂无历史会话）</div>
              ) : (
                sessions.map((s) => (
                  <div key={s.threadId} className="session-row">
                    <button
                      className="session-item"
                      onClick={() => {
                        post({ type: 'resumeSession', threadId: s.threadId });
                        setPanelView('none');
                      }}
                    >
                      <div className="session-time">{s.startedAt}</div>
                      <div className="session-preview">{s.preview || '(无预览)'}</div>
                    </button>
                    <button
                      className="session-del"
                      title="删除此会话"
                      onClick={() => post({ type: 'deleteSession', threadId: s.threadId })}
                    >
                      ×
                    </button>
                  </div>
                ))
              )
            ) : skills.length === 0 ? (
              <div className="dim">（未发现技能）</div>
            ) : (
              skills.map((s) => (
                <div key={s.name} className="skill-item">
                  <div className="skill-name">
                    {s.name}
                    {s.enabled ? '' : '（已禁用）'}
                  </div>
                  <div className="skill-desc">{s.description}</div>
                </div>
              ))
            )}
          </div>
          {settingsTab === 'history' && sessions.length > 0 ? (
            <div className="panel-actions">
              <button className="danger" onClick={() => post({ type: 'deleteAllSessions' })}>
                删除全部
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {agents.length > 0 ? (
        <div className="agent-tabs">
          <button
            className={'agent-tab parent' + (activeAgentId === '' ? ' active' : '')}
            onClick={() => setActiveAgentId('')}
          >
            主线程
          </button>
          {agents.map((a) => (
            <button
              key={a.threadId}
              className={'agent-tab' + (activeAgentId === a.threadId ? ' active' : '')}
              title={a.agentPath || a.threadId}
              onClick={() => {
                setActiveAgentId(a.threadId);
                // Re-subscribes if this agent was evicted, and marks it most recently used
                // so looking at a tab keeps it from being evicted next.
                post({ type: 'focusAgent', threadId: a.threadId });
              }}
            >
              <span className={`agent-dot s-${a.status}`} />
              {agentLabel(a)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="log">
        {visibleBlocks.map(renderBlock)}
        <div ref={bottomRef} />
      </div>

      {activeAgent ? (
        <div className="agent-bar">
          <span className="agent-bar-path">{activeAgent.agentPath || activeAgent.threadId}</span>
          <span className="agent-bar-note">
            {activeAgent.attachment === 'readOnly'
              ? '只读快照，另一个进程正在写入'
              : activeAgent.attachment === 'detached'
                ? '未订阅，正在重新连接'
                : activeAgent.canAcceptDirectInput
                  ? '可直接输入'
                  : '由父线程驱动，无法直接输入'}
          </span>
          {activeAgent.cwd ? (
            <button
              className="chip"
              title={activeAgent.cwd}
              onClick={() => post({ type: 'openPath', path: activeAgent.cwd as string })}
            >
              打开目录
            </button>
          ) : null}
          {activeAgent.status === 'running' ? (
            <button
              className="chip"
              onClick={() => post({ type: 'interrupt', threadId: activeAgent.threadId })}
            >
              中断
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="composer">
        <div
          className="composer-grip"
          title="拖拽调整输入框高度"
          onMouseDown={(e) => {
            const startY = e.clientY;
            const el = taRef.current;
            if (!el) {
              return;
            }
            const startH = el.offsetHeight;
            // No fixed cap: follow the viewport so the user can go as large
            // as the panel allows (leaving room for the tab bar and composer).
            const maxH = Math.max(160, window.innerHeight - 140);
            const move = (ev: MouseEvent) => {
              const h = Math.min(maxH, Math.max(52, startH + (startY - ev.clientY)));
              el.style.height = `${h}px`;
            };
            const up = () => {
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
              post({ type: 'saveComposerHeight', height: el.offsetHeight });
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
          }}
        />
        <textarea
          ref={taRef}
          value={inputText}
          placeholder={
            activeAgent
              ? '消息发给主线程，由它调度子 agent（Enter 发送）'
              : active
                ? '给 Codex 发消息（Enter 发送）'
                : '点右上 + 新建会话'
          }
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <span className="chip chip-static">Chat</span>
          <div className="model-anchor">
            <button className="chip" onClick={() => togglePanel('models')} title="选择模型">
              {modelLabel} ▾
            </button>
            {panelView === 'models' ? (
              <ModelPanel
                builtin={models.builtin}
                custom={models.custom}
                current={models.current}
                onClose={() => setPanelView('none')}
              />
            ) : null}
          </div>
          <button className="chip" onClick={() => openSettings('skills')}>
            Skills
          </button>
          <div className="composer-actions">
            {active?.busy ? (
              <button className="stop" title="中断" onClick={() => post({ type: 'interrupt', threadId: activeId })}>
                ■
              </button>
            ) : (
              <button className="send-btn" title="发送" onClick={send} disabled={!activeId || !inputText.trim()}>
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
