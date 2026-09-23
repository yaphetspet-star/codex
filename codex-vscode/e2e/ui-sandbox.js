/*
 * Interactive sandbox for manually testing the multi-agent UI.
 *
 * Real models cannot be made to spawn ten agents on demand, or to sit idle for two minutes,
 * which is exactly what the nested-tab UI needs to be pushed against. This serves the same
 * scripted Responses API as the e2e tests, but routes on what you type in the chat box, so
 * the extension drives a real app-server spawning real sub-agent threads.
 *
 *   1. node e2e/ui-sandbox.js        (leave running)
 *   2. F5 in VS Code -> "Run Extension (mock model)"
 *   3. Type one of the commands below into the Codex panel.
 *
 * See docs/ui-review.md for the test cases.
 */
const {
  evAssistantMessage,
  evCompleted,
  evCreated,
  execCommand,
  log,
  makeCodexHome,
  reply,
  spawn,
  startMockModelServer,
} = require('./harness');

/** Fixed so the launch configuration can point CODEX_HOME at a known directory. */
const PORT = 4571;
const HOME_DIR = '.codex-ui-sandbox';

/** Marks an agent's context so its requests can be told apart from everyone else's. */
const AGENT_TAG = 'SANDBOX-AGENT';
const tagFor = (kind, name) => `${AGENT_TAG} ${kind} ${name}`;

/** Agents hold their reply this long, so you can watch them in the running state. */
const NORMAL_WORK_MS = 12_000;
const SLOW_WORK_MS = 180_000;

const COMMANDS = `
  /one     spawn a single agent
  /three   spawn three agents at once
  /many    spawn ten agents (over the subscription cap of 8)
  /nest    spawn an agent that spawns one of its own, three levels deep
  /slow    spawn one agent that stays busy for three minutes
  /exec    spawn an agent that runs a shell command
  anything else gets a plain reply with no agents
`;

/** The text of the most recent user message, which is the command to act on. */
function lastUserText(input) {
  for (let i = input.length - 1; i >= 0; i--) {
    const entry = input[i];
    if (entry.type === 'message' && entry.role === 'user') {
      return (entry.content ?? [])
        .map((c) => c.text ?? '')
        .join(' ')
        .trim();
    }
  }
  return '';
}

/**
 * True once this agent has acted on its current instruction.
 *
 * Only items after the last user message count, so a second `/one` in the same conversation
 * spawns again instead of being shadowed by the first one's tool output.
 */
function alreadyActed(input) {
  let lastUser = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i].type === 'message' && input[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  return input.slice(lastUser + 1).some((entry) => entry.type === 'function_call_output');
}

let spawnSeq = 0;
const nextCallId = () => `sb-${++spawnSeq}`;

/** One turn that spawns every agent in `specs` at once. */
function spawnAll(specs) {
  const events = [evCreated(`resp-${nextCallId()}`)];
  for (const { kind, name } of specs) {
    events.push(
      ...spawn(`resp-${name}`, nextCallId(), name, tagFor(kind, name)).slice(1, -1),
    );
  }
  events.push(evCompleted(`resp-${nextCallId()}`));
  return events;
}

function rootTurn(text) {
  const command = text.toLowerCase();
  if (command.includes('/one')) {
    return spawnAll([{ kind: 'work', name: 'reviewer' }]);
  }
  if (command.includes('/three')) {
    return spawnAll([
      { kind: 'work', name: 'reviewer' },
      { kind: 'work', name: 'tester' },
      { kind: 'work', name: 'documenter' },
    ]);
  }
  if (command.includes('/many')) {
    return spawnAll(
      Array.from({ length: 10 }, (_, i) => ({ kind: 'work', name: `worker_${i + 1}` })),
    );
  }
  if (command.includes('/nest')) {
    return spawnAll([{ kind: 'nest', name: 'researcher' }]);
  }
  if (command.includes('/slow')) {
    return spawnAll([{ kind: 'slow', name: 'long_runner' }]);
  }
  if (command.includes('/exec')) {
    return spawnAll([{ kind: 'exec', name: 'builder' }]);
  }
  return reply('resp-plain', `No agents for that. Try one of:\n${COMMANDS}`);
}

function agentTurn(kind, name, input) {
  const acted = alreadyActed(input);
  switch (kind) {
    case 'nest':
      return acted
        ? {
            events: reply(`resp-${name}-done`, `${name}: my sub-agent finished, wrapping up.`),
            delayMs: NORMAL_WORK_MS,
          }
        : spawnAll([{ kind: 'work', name: `${name}_scraper` }]);
    case 'exec':
      return acted
        ? {
            events: reply(`resp-${name}-done`, `${name}: command finished.`),
            delayMs: NORMAL_WORK_MS,
          }
        : execCommand(`resp-${name}-exec`, nextCallId(), 'echo hello from the sandbox agent');
    case 'slow':
      return {
        events: reply(`resp-${name}-done`, `${name}: finally done.`),
        delayMs: SLOW_WORK_MS,
      };
    default:
      return {
        events: [
          evCreated(`resp-${name}`),
          evAssistantMessage(
            `msg-${name}`,
            `${name} reporting in.\n\nI looked at the workspace and everything seems fine.`,
          ),
          evCompleted(`resp-${name}`),
        ],
        delayMs: NORMAL_WORK_MS,
      };
  }
}

function route(body) {
  const parsed = JSON.parse(body);
  const input = parsed.input ?? [];
  const tag = body.match(new RegExp(`${AGENT_TAG} (\\w+) (\\w+)`));
  return tag ? agentTurn(tag[1], tag[2], input) : rootTurn(lastUserText(input));
}

async function main() {
  // The launch configuration's problem matcher waits for this line and the one after the
  // server binds, so it can hold the extension host back until the port is actually open.
  log('Starting mock model server');
  const { port } = await startMockModelServer(route, PORT);
  // The default concurrency budget is 4 threads including the root, which caps `/many` at
  // three agents -- too few to push the tab strip or the subscription limit.
  const home = makeCodexHome(port, HOME_DIR, ['max_concurrent_threads_per_session = 14']);
  log(`CODEX_HOME = ${home}`);
  log(`Commands you can type in the Codex panel:${COMMANDS}`);
  log('Ctrl+C to stop.');
  log(`Mock model listening on http://127.0.0.1:${port}`);
}

main().catch((err) => {
  console.error('sandbox failed to start:', err);
  process.exit(1);
});
