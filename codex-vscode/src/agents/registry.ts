import type { SubAgentActivityKind } from '../generated/v2/SubAgentActivityKind';
import type { Thread } from '../generated/v2/Thread';
import type { ThreadStatus } from '../generated/v2/ThreadStatus';
import type { ThreadItemOf } from '../protocol/items';

/**
 * Liveness of a sub-agent as far as the extension can tell.
 *
 * `unknown` covers agents seen only through an `interacted` activity, which says nothing
 * about whether the agent is still working.
 */
export type AgentStatus = 'running' | 'completed' | 'interrupted' | 'unknown';

/** How the extension is currently attached to a sub-agent's thread. */
export type AgentAttachment = 'detached' | 'live' | 'readOnly';

export interface AgentNode {
  threadId: string;
  parentThreadId: string;
  /** Canonical agent path such as `/root/researcher`, from the activity event. */
  agentPath: string;
  status: AgentStatus;
  attachment: AgentAttachment;
  /** Randomly assigned nickname, only known once the thread has been read. */
  nickname: string | null;
  /** Declared role, only known once the thread has been read. */
  role: string | null;
  cwd: string | null;
  /** False for v2 sub-agents, which are driven exclusively by their parent. */
  canAcceptDirectInput: boolean;
  /** Timestamp of the most recent event attributed to this agent. */
  updatedAt: number;
}

/**
 * The agent tree for one app-server connection.
 *
 * Sub-agents are discovered from `subAgentActivity` items on the parent thread, which is the
 * only signal available before the extension subscribes to the sub-agent's own thread. Each
 * agent is keyed by its thread id, so repeated activity for one agent updates a single node
 * rather than accumulating duplicates.
 */
export class AgentRegistry {
  private readonly nodes = new Map<string, AgentNode>();

  /**
   * Records a `subAgentActivity` item observed on `parentThreadId`.
   *
   * Returns true when the tree changed, so callers can avoid re-rendering on no-ops.
   */
  recordActivity(parentThreadId: string, item: ThreadItemOf<'subAgentActivity'>): boolean {
    const existing = this.nodes.get(item.agentThreadId);
    const status = statusForActivity(item.kind, existing?.status);
    const next: AgentNode = {
      threadId: item.agentThreadId,
      parentThreadId,
      agentPath: item.agentPath,
      status,
      attachment: existing?.attachment ?? 'detached',
      nickname: existing?.nickname ?? null,
      role: existing?.role ?? null,
      cwd: existing?.cwd ?? null,
      canAcceptDirectInput: existing?.canAcceptDirectInput ?? false,
      updatedAt: Date.now(),
    };
    return this.replace(next, existing);
  }

  /** Enriches a node with metadata from a `thread/resume` or `thread/read` response. */
  applyThread(thread: Thread, attachment: AgentAttachment): boolean {
    const existing = this.nodes.get(thread.id);
    if (!existing && !thread.parentThreadId) {
      return false;
    }
    const next: AgentNode = {
      threadId: thread.id,
      parentThreadId: thread.parentThreadId ?? existing?.parentThreadId ?? '',
      agentPath: existing?.agentPath ?? '',
      status: statusForThread(thread.status) ?? existing?.status ?? 'unknown',
      attachment,
      nickname: thread.agentNickname,
      role: thread.agentRole,
      cwd: thread.cwd,
      canAcceptDirectInput: thread.canAcceptDirectInput ?? false,
      updatedAt: Date.now(),
    };
    return this.replace(next, existing);
  }

  /**
   * Applies a `thread/status/changed` notification.
   *
   * These arrive for every loaded thread, subscribed or not, so they are the one liveness
   * signal that survives a sub-agent being evicted from the live subscription set. Threads
   * that are not known sub-agents are ignored.
   */
  applyStatus(threadId: string, status: ThreadStatus): boolean {
    const existing = this.nodes.get(threadId);
    const next = statusForThread(status);
    if (!existing || !next || existing.status === next) {
      return false;
    }
    this.nodes.set(threadId, { ...existing, status: next, updatedAt: Date.now() });
    return true;
  }

  setAttachment(threadId: string, attachment: AgentAttachment): boolean {
    const existing = this.nodes.get(threadId);
    if (!existing || existing.attachment === attachment) {
      return false;
    }
    this.nodes.set(threadId, { ...existing, attachment, updatedAt: Date.now() });
    return true;
  }

  get(threadId: string): AgentNode | undefined {
    return this.nodes.get(threadId);
  }

  has(threadId: string): boolean {
    return this.nodes.has(threadId);
  }

  /**
   * Walks up to the root session that owns a thread.
   *
   * The root is the first ancestor that is not itself a sub-agent, so a root thread id comes
   * back unchanged. Work attributed to a sub-agent — file changes above all — belongs to its
   * root session, which is where the user reviews and undoes it. Guarded against cycles.
   */
  rootThreadIdFor(threadId: string): string {
    const seen = new Set<string>();
    let current = threadId;
    while (seen.add(current)) {
      const parent = this.nodes.get(current)?.parentThreadId;
      if (!parent) {
        return current;
      }
      current = parent;
    }
    return current;
  }

  /** Direct children of a thread, oldest first so the list does not reorder as agents run. */
  childrenOf(parentThreadId: string): AgentNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.parentThreadId === parentThreadId)
      .sort((a, b) => a.agentPath.localeCompare(b.agentPath));
  }

  /** Every agent descended from a thread, in breadth-first order. */
  descendantsOf(rootThreadId: string): AgentNode[] {
    const out: AgentNode[] = [];
    const queue = [rootThreadId];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const child of this.childrenOf(current)) {
        out.push(child);
        queue.push(child.threadId);
      }
    }
    return out;
  }

  /** Drops a thread and everything spawned beneath it. */
  removeTree(rootThreadId: string): boolean {
    const doomed = this.descendantsOf(rootThreadId).map((node) => node.threadId);
    doomed.push(rootThreadId);
    let changed = false;
    for (const threadId of doomed) {
      changed = this.nodes.delete(threadId) || changed;
    }
    return changed;
  }

  private replace(next: AgentNode, existing: AgentNode | undefined): boolean {
    if (existing && equalIgnoringTimestamp(existing, next)) {
      return false;
    }
    this.nodes.set(next.threadId, next);
    return true;
  }
}

/**
 * Maps an activity kind onto liveness.
 *
 * `interacted` fires when the parent messages an agent and carries no liveness information,
 * so it must not overwrite a status already established by `started` or `completed`.
 */
function statusForActivity(
  kind: SubAgentActivityKind,
  previous: AgentStatus | undefined,
): AgentStatus {
  switch (kind) {
    case 'started':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'interacted':
      return previous ?? 'unknown';
  }
}

function statusForThread(status: ThreadStatus): AgentStatus | undefined {
  switch (status.type) {
    case 'active':
      return 'running';
    case 'idle':
      return 'completed';
    case 'systemError':
      return 'interrupted';
    case 'notLoaded':
      return undefined;
  }
}

function equalIgnoringTimestamp(a: AgentNode, b: AgentNode): boolean {
  return (
    a.threadId === b.threadId &&
    a.parentThreadId === b.parentThreadId &&
    a.agentPath === b.agentPath &&
    a.status === b.status &&
    a.attachment === b.attachment &&
    a.nickname === b.nickname &&
    a.role === b.role &&
    a.cwd === b.cwd &&
    a.canAcceptDirectInput === b.canAcceptDirectInput
  );
}
