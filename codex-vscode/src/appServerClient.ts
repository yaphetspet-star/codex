import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Notification {
  method: string;
  params?: any;
}

export interface ServerRequest {
  id: number | string;
  method: string;
  params?: any;
}

/**
 * Decision values expected by the v2 approval methods used by turn/start.
 * Verified against the running app-server: "approved" is the legacy v1 value
 * and leaves the turn stalled forever.
 */
export const APPROVAL_DECISIONS: Record<string, string> = {
  'item/commandExecution/requestApproval': 'acceptForSession',
  'item/fileChange/requestApproval': 'acceptForSession',
  execCommandApproval: 'approved',
  applyPatchApproval: 'approved',
};

/**
 * Locate the newest codex.exe under the per-user bin directory.
 *
 * `CODEX_BIN` overrides it, which is how the e2e suites run against a locally built
 * engine rather than the installed release.
 */
export function findCodexBin(): string {
  const override = process.env.CODEX_BIN;
  if (override) {
    return override;
  }
  const root = path.join(
    process.env.LOCALAPPDATA || '',
    'OpenAI',
    'Codex',
    'bin',
  );
  const found: string[] = [];
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
      } else if (e.name.toLowerCase() === 'codex.exe') {
        found.push(full);
      }
    }
  };
  walk(root);
  if (found.length === 0) {
    throw new Error(`codex.exe not found under ${root}`);
  }
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}

/**
 * Features the panel cannot work without, turned on for the process it spawns.
 *
 * The orchestration view is driven entirely by v2 events, so v1 would render nothing.
 * This has to happen at spawn time: `multi_agent_v2` is not in the app-server's
 * allowlist of runtime-settable features, so the enablement RPC silently ignores it.
 */
const REQUIRED_FEATURES = ['--enable', 'multi_agent_v2'];

/** Minimal JSON-RPC client for `codex app-server --listen stdio://`. */
export class AppServerClient {
  private proc: ChildProcessWithoutNullStreams;
  private seq = 0;
  /** Set by dispose() so an intentional shutdown is not reported as a crash. */
  private disposed = false;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  onNotification: (n: Notification) => void = () => {};
  onServerRequest: (r: ServerRequest) => void = () => {};
  onStderr: (s: string) => void = () => {};
  onExit: (code: number | null) => void = () => {};

  constructor(bin: string, cwd: string, extraEnv: Record<string, string> = {}) {
    this.proc = spawn(bin, ['app-server', '--listen', 'stdio://', ...REQUIRED_FEATURES], {
      cwd,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    let buf = '';
    this.proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          this.handleLine(line);
        }
      }
    });
    this.proc.stderr.on('data', (c: Buffer) => this.onStderr(c.toString('utf8')));
    this.proc.on('exit', (code) => {
      if (!this.disposed) {
        this.onExit(code);
      }
    });
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if ('id' in msg && 'method' in msg) {
      this.onServerRequest(msg as ServerRequest);
    } else if ('id' in msg) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(`${msg.error.message ?? 'request failed'}`));
        } else {
          waiter.resolve(msg.result ?? {});
        }
      }
    } else if ('method' in msg) {
      this.onNotification(msg as Notification);
    }
  }

  private send(msg: any) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method: string, params: any = {}, timeoutMs = 120_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ method, id, params });
    });
  }

  notify(method: string, params: any = {}) {
    this.send({ method, params });
  }

  respond(id: number | string, result: any) {
    this.send({ id, result });
  }

  dispose() {
    this.disposed = true;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
