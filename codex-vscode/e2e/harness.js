/*
 * Shared plumbing for the end-to-end checks: a scripted stand-in for the Responses API, an
 * isolated CODEX_HOME, and a client wired to a real `codex app-server`.
 *
 * No model credentials are involved. The mock server decides what the "model" says by matching
 * markers in the request body, which is also how it tells the parent agent's requests apart
 * from those of the agents it spawns.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppServerClient, findCodexBin } = require('../out/appServerClient');

const log = (...args) => console.log(...args);

function sse(events) {
  return events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
}

const evCreated = (id) => ({ type: 'response.created', response: { id } });
const evCompleted = (id) => ({
  type: 'response.completed',
  response: {
    id,
    usage: {
      input_tokens: 0,
      input_tokens_details: null,
      output_tokens: 0,
      output_tokens_details: null,
      total_tokens: 0,
    },
  },
});
const evAssistantMessage = (id, text) => ({
  type: 'response.output_item.done',
  item: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] },
});
/** Multi-agent v2 exposes its tools under the `collaboration` namespace, not as bare functions. */
const evNamespacedCall = (callId, namespace, name, args) => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: callId, namespace, name, arguments: args },
});
const evFunctionCall = (callId, name, args) => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: callId, name, arguments: args },
});

/** A canned turn that just says something and ends. */
const reply = (id, text) => [evCreated(id), evAssistantMessage(id, text), evCompleted(id)];

/**
 * A turn that spawns a sub-agent.
 *
 * `fork_turns: 'none'` gives the child a clean context, which is what keeps the parent's
 * marker out of the child's request bodies and makes marker routing unambiguous.
 */
const spawn = (id, callId, taskName, message) => [
  evCreated(id),
  evNamespacedCall(
    callId,
    'collaboration',
    'spawn_agent',
    JSON.stringify({ task_name: taskName, message, fork_turns: 'none' }),
  ),
  evCompleted(id),
];

/** A turn that runs a shell command. */
const execCommand = (id, callId, cmd) => [
  evCreated(id),
  evFunctionCall(callId, 'exec_command', JSON.stringify({ cmd, yield_time_ms: 2000 })),
  evCompleted(id),
];

/**
 * Serves the Responses API from a script.
 *
 * `scripts` is either a marker map or a router function. As a map, it pairs a marker string
 * with the turns to serve, in order, to whichever agent has that marker in its context; the
 * last entry repeats so an agent that keeps talking never stalls the run. As a function, it
 * receives the raw request body and returns the turn to serve, which is what the interactive
 * sandbox needs to react to whatever the user typed.
 */
function startMockModelServer(scripts, port = 0) {
  const callCounts = new Map();
  const route = typeof scripts === 'function' ? scripts : undefined;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (!req.url.includes('/responses')) {
        log(`[mock] unexpected path ${req.method} ${req.url}`);
        res.writeHead(404).end();
        return;
      }

      let turn;
      let label;
      if (route) {
        turn = route(body);
        label = 'routed';
      } else {
        const marker = Object.keys(scripts).find((m) => body.includes(m));
        if (marker) {
          const index = callCounts.get(marker) ?? 0;
          callCounts.set(marker, index + 1);
          const turns = scripts[marker];
          turn = turns[Math.min(index, turns.length - 1)];
          label = `${marker} turn #${index + 1}`;
        }
      }
      if (!turn) {
        log('[mock] nothing matched; ending the turn');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse(reply('resp-unmatched', 'done')));
        return;
      }
      const { events, delayMs = 0 } = Array.isArray(turn) ? { events: turn } : turn;

      log(`[mock] ${label}${delayMs ? ` (holding ${delayMs}ms)` : ''}`);
      if (process.env.E2E_DEBUG) {
        const parsed = JSON.parse(body);
        const names = (parsed.tools ?? []).map((t) => t.name ?? t.type);
        log(`[mock:debug]   tools: ${names.join(', ') || '(none)'}`);
        for (const entry of parsed.input ?? []) {
          if (entry.type === 'function_call_output') {
            log(`[mock:debug]   output: ${JSON.stringify(entry.output).slice(0, 300)}`);
          }
        }
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (delayMs) {
        // Keep the stream open so the agent's turn is genuinely still in progress.
        await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end(sse(events));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function makeCodexHome(port, dirName = '.codex-e2e-home', extraConfigLines = []) {
  // Reused rather than unique per run: the app-server holds its rollout files open past exit
  // on Windows, so the directory can only be cleared reliably before the next run starts.
  // It must also stay out of the system temp dir, which codex refuses to write helpers into.
  const home = path.join(os.homedir(), dirName);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(
    path.join(home, 'config.toml'),
    [
      // A built-in slug that declares multi-agent v2. Under v2 a non-root agent only receives
      // the `collaboration` tools when the model itself declares v2 (`collab_tools_enabled`),
      // so nested spawning depends on this choice.
      'model = "gpt-5.6-sol"',
      'model_provider = "mock"',
      'approval_policy = "never"',
      '',
      '[model_providers.mock]',
      'name = "Mock"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'env_key = "MOCK_API_KEY"',
      '',
      // Kept last so callers can append more keys to this same table.
      '[features.multi_agent_v2]',
      'enabled = true',
      ...extraConfigLines,
      '',
    ].join('\n'),
  );
  return home;
}

/** Records every notification and server request, and auto-approves anything asked of it. */
function createClient(codexHome) {
  const client = new AppServerClient(findCodexBin(), process.cwd(), {
    CODEX_HOME: codexHome,
    MOCK_API_KEY: 'mock-key',
  });

  const events = [];
  const approvalRequests = [];

  client.onNotification = (n) => {
    events.push(n);
    if (process.env.E2E_VERBOSE && n.method !== 'item/agentMessage/delta') {
      const item = n.params?.item;
      log(`[notif] ${n.method} ${(n.params?.threadId ?? '').slice(0, 8)} ${item?.type ?? ''}`);
    }
  };
  client.onServerRequest = (r) => {
    approvalRequests.push(r);
    log(`[approval] ${r.method} thread=${(r.params?.threadId ?? '?').slice(0, 8)}`);
    client.respond(r.id, { decision: 'acceptForSession' });
  };
  client.onStderr = () => {};

  return { client, events, approvalRequests };
}

/** Resolves once `predicate` matches a recorded notification, or rejects on timeout. */
function waitFor(events, predicate, label, timeoutMs = 45000) {
  const existing = events.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 100);
  });
}

/** Waits for the sub-agent spawned under `parentThreadId` whose path ends in `taskName`. */
async function waitForSpawn(events, parentThreadId, taskName) {
  const notification = await waitFor(
    events,
    (n) =>
      n.method === 'item/completed' &&
      n.params?.threadId === parentThreadId &&
      n.params.item?.type === 'subAgentActivity' &&
      n.params.item.kind === 'started' &&
      n.params.item.agentPath.endsWith(`/${taskName}`),
    `spawn of ${taskName}`,
  );
  return notification.params.item;
}

class Checks {
  constructor() {
    this.failures = [];
  }

  check(name, ok, detail = '') {
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) {
      this.failures.push(name);
    }
    return ok;
  }
}

module.exports = {
  Checks,
  createClient,
  evAssistantMessage,
  evCompleted,
  evCreated,
  execCommand,
  log,
  makeCodexHome,
  reply,
  spawn,
  startMockModelServer,
  waitFor,
  waitForSpawn,
};
