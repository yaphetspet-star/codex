import type { ThreadItem } from '../generated/v2/ThreadItem';

/** Narrows the `ThreadItem` union to the member carrying a given `type` tag. */
export type ThreadItemOf<K extends ThreadItem['type']> = Extract<ThreadItem, { type: K }>;

/**
 * Whether a file change item has finished applying.
 *
 * `item/started` and `item/completed` both carry the full item, so the status field is
 * what distinguishes a patch that is still being applied from one already on disk.
 */
export function isPatchApplied(item: ThreadItemOf<'fileChange'>): boolean {
  return item.status === 'completed';
}

/** Flattens the tagged `PatchChangeKind` into the lowercase string the webview renders. */
export function patchChangeKind(change: ThreadItemOf<'fileChange'>['changes'][number]): string {
  return change.kind.type;
}

/** Counts added/removed lines in a unified diff. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }
  return { added, removed };
}
