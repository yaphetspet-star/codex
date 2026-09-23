/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Thin wrapper around the VS Code webview bridge.
 * Falls back to a no-op when loaded outside VS Code (plain browser preview).
 */
const api: any =
  typeof (window as any).acquireVsCodeApi === 'function'
    ? (window as any).acquireVsCodeApi()
    : { postMessage: (_m: unknown) => undefined };

export function post(msg: Record<string, unknown>) {
  api.postMessage(msg);
}

export interface Question {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description: string }[];
}

export interface SessionSummary {
  threadId: string;
  startedAt: string;
  preview: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  scope: string;
}

export interface CustomModel {
  key: string;
  providerName: string;
  providerId: string;
  model: string;
  baseUrl: string;
}

/** Distributed Omit so each union member keeps its own shape. */
type DistributedOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type BlockInput = DistributedOmit<Block, 'id'>;

export interface FileChangeSummary {
  path: string;
  kind: string;
  added: number;
  removed: number;
}

export type AgentStatus = 'running' | 'completed' | 'interrupted' | 'unknown';
export type AgentAttachment = 'detached' | 'live' | 'readOnly';

/** One sub-agent, mirroring `AgentNode` on the extension host. */
export interface AgentInfo {
  threadId: string;
  parentThreadId: string;
  agentPath: string;
  status: AgentStatus;
  attachment: AgentAttachment;
  nickname: string | null;
  role: string | null;
  cwd: string | null;
  canAcceptDirectInput: boolean;
  updatedAt: number;
}

export type Block =
  | { id: string; kind: 'status'; text: string }
  | { id: string; kind: 'you'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | { id: string; kind: 'tool'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'files'; items: FileChangeSummary[] }
  | { id: string; kind: 'agents' }
  | { id: string; kind: 'ask'; requestId: string; questions: Question[] }
  | { id: string; kind: 'checkpoint'; turnId: string }
  | { id: string; kind: 'error'; text: string };

export type HostMessage =
  | { type: 'status'; text: string }
  | {
      type: 'threadOpened';
      threadId: string;
      title: string;
      cwd?: string;
      model?: string;
      provider?: string;
    }
  | { type: 'threadClosed'; threadId: string }
  | { type: 'threadRenamed'; threadId: string; title: string }
  | { type: 'delta'; threadId?: string; text: string }
  | { type: 'thinking'; threadId?: string; text: string }
  | { type: 'tool'; threadId?: string; text: string }
  | { type: 'you'; threadId?: string; text: string }
  | { type: 'files'; threadId?: string; items: FileChangeSummary[] }
  | { type: 'ask'; threadId?: string; requestId: string; questions: Question[] }
  | { type: 'done'; threadId?: string; status: string }
  | { type: 'checkpoint'; threadId?: string; turnId: string }
  | { type: 'error'; threadId?: string; text: string }
  | { type: 'clear'; threadId?: string }
  | { type: 'sessions'; items: SessionSummary[] }
  | { type: 'skills'; items: SkillSummary[] }
  | {
      type: 'models';
      builtin: { id: string; name: string }[];
      custom: CustomModel[];
      current: { model: string; provider: string };
    }
  | { type: 'modelChanged'; model: string; provider: string }
  | { type: 'showPanel'; panel: 'history' | 'skills' }
  | { type: 'agentTree'; rootThreadId: string; nodes: AgentInfo[] }
  | {
      type: 'multiAgent';
      version: MultiAgentVersion;
      featureV2Enabled: boolean;
      collabEnabled: boolean;
      modelDeclaredVersion: MultiAgentVersion | null;
      nestedSpawnSupported: boolean;
    }
  | { type: 'composerHeight'; height: number }
  | { type: 'doExport' };

export type MultiAgentVersion = 'disabled' | 'v1' | 'v2';
