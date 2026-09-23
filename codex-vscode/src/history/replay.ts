/*
 * Rebuilds a thread's transcript in the panel after the extension restarts.
 *
 * The live path never renders messages from items: assistant text and reasoning arrive as
 * `item/*` deltas and are appended as they stream. A resumed thread has no deltas, only
 * finished `ThreadItem`s, so replaying history needs its own mapping onto the same webview
 * messages the streaming path produces.
 */
import type { FileUpdateChange } from '../generated/v2/FileUpdateChange';
import type { ThreadItem } from '../generated/v2/ThreadItem';
import type { Turn } from '../generated/v2/Turn';
import type { UserInput } from '../generated/v2/UserInput';

/** Newest turns to replay. Older ones stay reachable through the history panel. */
export const MAX_REPLAYED_TURNS = 50;

/** Page requested from `thread/resume` so items come back whole rather than summarised. */
export const INITIAL_TURNS_PAGE = {
  limit: MAX_REPLAYED_TURNS,
  // Newest first, so a long thread yields its tail rather than its head.
  sortDirection: 'desc',
  itemsView: 'full',
} as const;

/** A recorded file change, in the shape the diff and undo paths already expect. */
export interface RecordedChange {
  path: string;
  kind: string;
  diff: string;
}

export interface ReplayHandlers {
  /** Posts one webview message for the thread being restored. */
  emit: (message: Record<string, unknown>) => void;
  /** Re-registers a file change so diff and undo keep working after a restart. */
  recordChange: (change: RecordedChange) => void;
  /** Classifies `FileUpdateChange.kind`, which is a tagged object rather than a string. */
  changeKind: (change: FileUpdateChange) => string;
  /** Summarises a diff into added/removed counts for the file list. */
  diffStat: (diff: string) => Record<string, unknown>;
}

/**
 * Picks the turns to replay, oldest first.
 *
 * `thread/resume` fills `thread.turns`, but only the requested page carries full items, so
 * the page wins when present. The page is requested newest-first and reversed here.
 */
export function turnsToReplay(
  initialTurnsPage: { data: Turn[] } | null | undefined,
  threadTurns: Turn[] | undefined,
): Turn[] {
  if (initialTurnsPage?.data?.length) {
    return [...initialTurnsPage.data].reverse();
  }
  return (threadTurns ?? []).slice(-MAX_REPLAYED_TURNS);
}

/** Flattens user input back into the text that was typed. */
function userText(content: UserInput[]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'skill':
        case 'mention':
          return part.name;
        case 'image':
        case 'audio':
          return `[${part.type}]`;
        case 'localImage':
        case 'localAudio':
          return `[${part.type}: ${part.path}]`;
      }
    })
    .join('')
    .trim();
}

/** Reasoning shows its summary when there is one, since that is what the live path streams. */
function reasoningText(summary: string[], content: string[]): string {
  const source = summary.length ? summary : content;
  return source.join('\n').trim();
}

function replayItem(item: ThreadItem, handlers: ReplayHandlers): void {
  const { emit } = handlers;
  switch (item.type) {
    case 'userMessage': {
      const text = userText(item.content);
      if (text) {
        emit({ type: 'you', text });
      }
      break;
    }
    case 'agentMessage':
      if (item.text.trim()) {
        // Appends to the current assistant bubble, so separate messages need a break.
        emit({ type: 'delta', text: `${item.text}\n\n` });
      }
      break;
    case 'reasoning': {
      const text = reasoningText(item.summary, item.content);
      if (text) {
        emit({ type: 'thinking', text: `${text}\n` });
      }
      break;
    }
    case 'commandExecution': {
      const output = item.aggregatedOutput ?? '';
      const tail = item.exitCode === 0 ? '[ok]\n' : `[exit=${item.exitCode ?? '?'}]\n`;
      emit({ type: 'tool', text: `\n$ ${item.command}\n${output}${tail}` });
      break;
    }
    case 'fileChange': {
      const items = item.changes.map((change) => {
        const kind = handlers.changeKind(change);
        handlers.recordChange({ path: change.path, kind, diff: change.diff });
        return { path: change.path, kind, ...handlers.diffStat(change.diff) };
      });
      if (items.length) {
        emit({ type: 'files', items });
      }
      break;
    }
    case 'plan':
      if (item.text.trim()) {
        emit({ type: 'delta', text: `${item.text}\n\n` });
      }
      break;
    case 'hookPrompt':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'subAgentActivity':
    case 'webSearch':
    case 'imageView':
    case 'sleep':
    case 'imageGeneration':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'contextCompaction':
      // Nothing the transcript renders today. Sub-agent transcripts in particular live on
      // their own threads and are not restored with the parent.
      break;
  }
}

/**
 * Replays turns into the panel, oldest first.
 *
 * Each turn ends with a checkpoint so the per-turn revert control survives a restart, just
 * as it appears from `turn/completed` while streaming.
 */
export function replayTurns(turns: Turn[], handlers: ReplayHandlers): void {
  for (const turn of turns) {
    for (const item of turn.items) {
      replayItem(item, handlers);
    }
    handlers.emit({ type: 'checkpoint', turnId: turn.id });
  }
}
