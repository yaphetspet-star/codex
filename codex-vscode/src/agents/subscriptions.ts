import type { Thread } from '../generated/v2/Thread';
import type { ThreadReadResponse } from '../generated/v2/ThreadReadResponse';
import type { ThreadResumeResponse } from '../generated/v2/ThreadResumeResponse';
import type { Request } from '../protocol/capabilities';
import type { AgentAttachment } from './registry';

/** Attaching to more threads than this starts evicting the least recently used ones. */
const DEFAULT_MAX_LIVE = 8;

/** How long to keep retrying a resume that fails only because the rollout is not on disk yet. */
const RESUME_RETRY_BUDGET_MS = 5000;
const RESUME_RETRY_INTERVAL_MS = 250;

export interface Attachment {
  thread: Thread;
  attachment: Exclude<AgentAttachment, 'detached'>;
}

/**
 * Keeps a bounded set of sub-agent threads subscribed for live events.
 *
 * App-server only streams `item/*` and `turn/*` notifications for threads the connection has
 * explicitly subscribed to, and sub-agents spawned inside the engine are never subscribed
 * automatically. Attaching therefore means `thread/resume`, which both replays the thread's
 * history and registers this connection as a listener.
 *
 * Each subscription costs a listener task and an event stream on the server, so the number of
 * simultaneously attached threads is capped and the least recently touched thread is dropped
 * when the cap is exceeded.
 */
export class SubscriptionManager {
  /** Attached threads in least-recently-touched first order. */
  private readonly live = new Map<string, Exclude<AgentAttachment, 'detached'>>();
  private readonly inFlight = new Map<string, Promise<Attachment | undefined>>();

  constructor(
    private readonly request: Request,
    private readonly onEvicted: (threadId: string) => void,
    private readonly maxLive: number = DEFAULT_MAX_LIVE,
  ) {}

  attachmentOf(threadId: string): AgentAttachment {
    return this.live.get(threadId) ?? 'detached';
  }

  /**
   * Subscribes to a thread, replaying its history.
   *
   * Resuming with only a thread id deliberately omits every settings override so a thread that
   * is already loaded and mid-turn keeps its own model, permissions, and cwd. When another
   * process holds the thread open for writing, this falls back to a read-only snapshot, which
   * yields history but no live events.
   */
  async attach(threadId: string): Promise<Attachment | undefined> {
    const pending = this.inFlight.get(threadId);
    if (pending) {
      return pending;
    }
    if (this.live.has(threadId)) {
      this.touch(threadId);
      return undefined;
    }
    const task = this.attachUncached(threadId).finally(() => this.inFlight.delete(threadId));
    this.inFlight.set(threadId, task);
    return task;
  }

  async detach(threadId: string): Promise<void> {
    if (!this.live.delete(threadId)) {
      return;
    }
    try {
      await this.request('thread/unsubscribe', { threadId });
    } catch {
      // The thread may already be unloaded; the local state is authoritative either way.
    }
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((threadId) => this.detach(threadId)));
  }

  /** Marks a thread as recently used so it is evicted last. */
  touch(threadId: string): void {
    const attachment = this.live.get(threadId);
    if (attachment) {
      this.live.delete(threadId);
      this.live.set(threadId, attachment);
    }
  }

  private async attachUncached(threadId: string): Promise<Attachment | undefined> {
    let result: Attachment | undefined;
    let lastError: unknown;

    // The engine announces a sub-agent before its rollout file is flushed, so for a short window
    // after the spawn `thread/resume` fails with an empty rollout. Retry across that window.
    const deadline = Date.now() + RESUME_RETRY_BUDGET_MS;
    while (!result) {
      try {
        const res = (await this.request('thread/resume', { threadId })) as ThreadResumeResponse;
        result = { thread: res.thread, attachment: 'live' };
      } catch (err) {
        lastError = err;
        if (!isUnflushedRolloutError(err) || Date.now() >= deadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, RESUME_RETRY_INTERVAL_MS));
      }
    }

    if (!result) {
      if (!isActiveWriterError(lastError)) {
        return undefined;
      }
      try {
        const res = (await this.request('thread/read', {
          threadId,
          includeTurns: true,
        })) as ThreadReadResponse;
        result = { thread: res.thread, attachment: 'readOnly' };
      } catch {
        return undefined;
      }
    }

    this.live.set(threadId, result.attachment);
    await this.evictOverflow();
    return result;
  }

  private async evictOverflow(): Promise<void> {
    while (this.live.size > this.maxLive) {
      const oldest = this.live.keys().next();
      if (oldest.done) {
        return;
      }
      await this.detach(oldest.value);
      this.onEvicted(oldest.value);
    }
  }
}

/**
 * Detects the error app-server returns when another process owns the thread for writing.
 *
 * The condition is only reported as an error string, so matching the message is the sole way
 * to tell it apart from a genuine failure.
 */
function isActiveWriterError(err: unknown): boolean {
  return String(err).includes('already has an active writer');
}

/**
 * Detects a resume that raced the engine writing the thread's rollout to disk.
 *
 * Like the active-writer case, app-server only surfaces this as an error string.
 */
function isUnflushedRolloutError(err: unknown): boolean {
  const message = String(err);
  return message.includes('failed to read session metadata') || message.includes('rollout at');
}
