/*
 * End-to-end checks of the multi-agent orchestration path against a real `codex app-server`.
 *
 * These drive the extension's own `AgentRegistry` and `SubscriptionManager`, so they are a
 * regression test of the shipped code rather than just a protocol probe. See `harness.js` for
 * how the model is faked.
 *
 * Run with: npm run test:e2e   (add E2E_VERBOSE=1 to see every notification)
 */
const {
  Checks,
  createClient,
  execCommand,
  log,
  makeCodexHome,
  reply,
  spawn,
  startMockModelServer,
  waitFor,
  waitForSpawn,
} = require('./harness');
const { AgentRegistry } = require('../out/agents/registry');
const { SubscriptionManager } = require('../out/agents/subscriptions');

/**
 * Context markers, one per agent.
 *
 * Declared ancestors first: a parent's context accumulates the spawn arguments it sent, so it
 * contains its descendants' markers too, and the mock server matches the first marker listed.
 */
const MARK = {
  basicsParent: 'E2E-basics-parent',
  basicsChild: 'E2E-basics-child',
  nestedParent: 'E2E-nested-parent',
  nestedChild: 'E2E-nested-child',
  nestedGrandchild: 'E2E-nested-grandchild',
  evictParent: 'E2E-evict-parent',
  evictFirst: 'E2E-evict-first',
  evictSecond: 'E2E-evict-second',
  approvalParent: 'E2E-approval-parent',
  approvalChild: 'E2E-approval-child',
  refocusParent: 'E2E-refocus-parent',
  refocusChild: 'E2E-refocus-child',
};

/** Long enough that an agent's turn is reliably still running while the test inspects it. */
const HOLD_MS = 6000;

const SCRIPTS = {
  [MARK.basicsParent]: [
    spawn('r-basics-1', 'call-basics-1', 'mock_worker', MARK.basicsChild),
    reply('r-basics-2', 'delegated to the worker'),
  ],
  [MARK.basicsChild]: [{ events: reply('r-basics-c', 'worker finished'), delayMs: HOLD_MS }],

  [MARK.nestedParent]: [
    spawn('r-nested-1', 'call-nested-1', 'researcher', MARK.nestedChild),
    reply('r-nested-2', 'delegated to the researcher'),
  ],
  [MARK.nestedChild]: [
    spawn('r-nested-c1', 'call-nested-c1', 'scraper', MARK.nestedGrandchild),
    { events: reply('r-nested-c2', 'research done'), delayMs: HOLD_MS },
  ],
  [MARK.nestedGrandchild]: [
    { events: reply('r-nested-g', 'scraping done'), delayMs: HOLD_MS },
  ],

  [MARK.evictParent]: [
    spawn('r-evict-1', 'call-evict-1', 'first_worker', MARK.evictFirst),
    spawn('r-evict-2', 'call-evict-2', 'second_worker', MARK.evictSecond),
    reply('r-evict-3', 'both workers running'),
  ],
  [MARK.evictFirst]: [{ events: reply('r-evict-f', 'first done'), delayMs: HOLD_MS }],
  [MARK.evictSecond]: [{ events: reply('r-evict-s', 'second done'), delayMs: HOLD_MS }],

  [MARK.approvalParent]: [
    spawn('r-appr-1', 'call-appr-1', 'builder', MARK.approvalChild),
    reply('r-appr-2', 'delegated to the builder'),
  ],
  [MARK.approvalChild]: [
    execCommand('r-appr-c1', 'call-appr-exec', 'echo hello-from-subagent'),
    reply('r-appr-c2', 'build done'),
  ],

  [MARK.refocusParent]: [
    spawn('r-refocus-1', 'call-refocus-1', 'note_taker', MARK.refocusChild),
    reply('r-refocus-2', 'delegated to the note taker'),
  ],
  [MARK.refocusChild]: [reply('r-refocus-c', 'notes written')],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a root thread and sends it the prompt that kicks off a scenario. */
async function startRootTurn(client, marker, extraStartParams = {}) {
  const started = await client.request(
    'thread/start',
    {
      cwd: process.cwd(),
      ...extraStartParams,
    },
    60000,
  );
  const threadId = started.thread.id;
  // Not awaited: the turn only resolves when the whole agent tree settles.
  const turn = client.request(
    'turn/start',
    { threadId, input: [{ type: 'text', text: marker, textElements: [] }] },
    120000,
  );
  turn.catch(() => {});
  return threadId;
}

function newAgentState(client) {
  const agents = new AgentRegistry();
  const evicted = [];
  const subscriptions = new SubscriptionManager(
    (method, params, timeoutMs) => client.request(method, params, timeoutMs),
    (threadId) => {
      agents.setAttachment(threadId, 'detached');
      evicted.push(threadId);
    },
    Number(process.env.E2E_MAX_LIVE) || undefined,
  );
  return { agents, evicted, subscriptions };
}

/**
 * The core contract: a spawned child is discoverable, attachable while still running, and
 * streams its transcript only once attached.
 */
async function scenarioBasics({ client, events, checks }) {
  const { agents, subscriptions } = newAgentState(client);
  const parentThreadId = await startRootTurn(client, MARK.basicsParent);

  const activity = await waitForSpawn(events, parentThreadId, 'mock_worker');
  const childThreadId = activity.agentThreadId;
  agents.recordActivity(parentThreadId, activity);
  checks.check('parent emits subAgentActivity', true, `path=${activity.agentPath}`);

  const pair = events.filter(
    (n) =>
      (n.method === 'item/started' || n.method === 'item/completed') &&
      n.params?.item?.type === 'subAgentActivity' &&
      n.params.item.agentThreadId === childThreadId &&
      n.params.item.kind === 'started',
  );
  checks.check(
    'started activity arrives as an item/started + item/completed pair',
    pair.length === 2,
    `got ${pair.length}`,
  );

  const preSubscribe = events.filter((n) => n.params?.threadId === childThreadId);
  checks.check(
    'no child transcript events arrive before subscribing',
    !preSubscribe.some((n) => n.method.startsWith('item/')),
    `pre-subscribe: ${[...new Set(preSubscribe.map((n) => n.method))].join(', ') || 'none'}`,
  );

  // Races the engine flushing the child's rollout, which is why attach retries internally.
  const beforeAttach = Date.now();
  const attached = await subscriptions.attach(childThreadId);
  if (
    !checks.check(
      'SubscriptionManager attaches to a freshly spawned child',
      Boolean(attached),
      attached ? `${attached.attachment} after ${Date.now() - beforeAttach}ms` : 'returned undefined',
    )
  ) {
    return;
  }
  agents.applyThread(attached.thread, attached.attachment);

  checks.check(
    'attached child reports parent, refuses direct input, still active',
    attached.thread.parentThreadId === parentThreadId &&
      attached.thread.canAcceptDirectInput === false &&
      attached.thread.status?.type === 'active',
    `parent=${attached.thread.parentThreadId === parentThreadId} input=${attached.thread.canAcceptDirectInput} status=${attached.thread.status?.type}`,
  );

  const node = agents.descendantsOf(parentThreadId)[0] ?? {};
  checks.check(
    'agent tree node carries path, liveness and attachment',
    agents.descendantsOf(parentThreadId).length === 1 &&
      node.agentPath === '/root/mock_worker' &&
      node.status === 'running' &&
      node.attachment === 'live',
    JSON.stringify({ path: node.agentPath, status: node.status, nickname: node.nickname }),
  );

  const completed = await waitFor(
    events,
    (n) => n.method === 'turn/completed' && n.params?.threadId === childThreadId,
    'child turn/completed',
  );
  checks.check(
    'child turn completes after being attached',
    completed.params.turn.status === 'completed',
    `status=${completed.params.turn.status}`,
  );

  const message = events.find(
    (n) =>
      n.method === 'item/completed' &&
      n.params?.threadId === childThreadId &&
      n.params.item?.type === 'agentMessage',
  );
  checks.check(
    'child agent message streams to the subscriber',
    Boolean(message),
    message ? `"${message.params.item.text}"` : 'none received',
  );

  await subscriptions.detach(childThreadId);
  checks.check(
    'detach clears the live subscription',
    subscriptions.attachmentOf(childThreadId) === 'detached',
  );
}

/** A sub-agent can spawn its own sub-agent; the tree and root attribution must survive that. */
async function scenarioNested({ client, events, checks }) {
  const { agents, subscriptions } = newAgentState(client);
  const parentThreadId = await startRootTurn(client, MARK.nestedParent);

  const childActivity = await waitForSpawn(events, parentThreadId, 'researcher');
  const childThreadId = childActivity.agentThreadId;
  agents.recordActivity(parentThreadId, childActivity);

  // The grandchild's activity is emitted on the child's thread, so it is only visible once
  // the child itself is attached. That dependency is the point of this scenario.
  const attachedChild = await subscriptions.attach(childThreadId);
  if (!checks.check('nested: attached to the intermediate agent', Boolean(attachedChild))) {
    return;
  }
  agents.applyThread(attachedChild.thread, attachedChild.attachment);

  let grandchildActivity;
  try {
    grandchildActivity = await waitForSpawn(events, childThreadId, 'scraper');
  } catch (err) {
    checks.check('nested: grandchild activity observed on the child thread', false, String(err));
    return;
  }
  checks.check(
    'nested: grandchild activity observed on the child thread',
    true,
    `path=${grandchildActivity.agentPath}`,
  );
  agents.recordActivity(childThreadId, grandchildActivity);
  const grandchildThreadId = grandchildActivity.agentThreadId;

  const tree = agents.descendantsOf(parentThreadId);
  checks.check(
    'nested: descendantsOf returns both levels',
    tree.length === 2 && tree.some((n) => n.threadId === grandchildThreadId),
    tree.map((n) => n.agentPath).join(' | '),
  );
  checks.check(
    'nested: children are attributed to their own parent',
    agents.childrenOf(parentThreadId).length === 1 &&
      agents.childrenOf(childThreadId).length === 1,
    `root=${agents.childrenOf(parentThreadId).length} child=${agents.childrenOf(childThreadId).length}`,
  );

  // File changes made anywhere in the tree belong to the root session's review list.
  checks.check(
    'nested: rootThreadIdFor walks a grandchild back to the root session',
    agents.rootThreadIdFor(grandchildThreadId) === parentThreadId &&
      agents.rootThreadIdFor(parentThreadId) === parentThreadId,
    `grandchild -> ${agents.rootThreadIdFor(grandchildThreadId).slice(0, 8)}`,
  );

  const attachedGrandchild = await subscriptions.attach(grandchildThreadId);
  checks.check(
    'nested: a grandchild is attachable too',
    Boolean(attachedGrandchild),
    attachedGrandchild ? `${attachedGrandchild.attachment}` : 'returned undefined',
  );

  checks.check(
    'nested: removeTree drops the whole subtree',
    agents.removeTree(parentThreadId) && agents.descendantsOf(parentThreadId).length === 0,
  );
  await subscriptions.detach(childThreadId);
  await subscriptions.detach(grandchildThreadId);
}

/** Over the cap, the least recently used agent is dropped but keeps reporting its status. */
async function scenarioEviction({ client, events, checks }) {
  const agents = new AgentRegistry();
  const evicted = [];
  const subscriptions = new SubscriptionManager(
    (method, params, timeoutMs) => client.request(method, params, timeoutMs),
    (threadId) => {
      agents.setAttachment(threadId, 'detached');
      evicted.push(threadId);
    },
    /*maxLive*/ 1,
  );

  const parentThreadId = await startRootTurn(client, MARK.evictParent);
  const firstActivity = await waitForSpawn(events, parentThreadId, 'first_worker');
  agents.recordActivity(parentThreadId, firstActivity);
  const firstId = firstActivity.agentThreadId;
  const firstAttached = await subscriptions.attach(firstId);
  if (firstAttached) {
    agents.applyThread(firstAttached.thread, firstAttached.attachment);
  }

  const secondActivity = await waitForSpawn(events, parentThreadId, 'second_worker');
  agents.recordActivity(parentThreadId, secondActivity);
  const secondId = secondActivity.agentThreadId;
  const evictionMark = events.length;
  const secondAttached = await subscriptions.attach(secondId);
  if (secondAttached) {
    agents.applyThread(secondAttached.thread, secondAttached.attachment);
  }

  checks.check(
    'eviction: exceeding the cap evicts the least recently used agent',
    evicted.length === 1 && evicted[0] === firstId,
    `evicted ${evicted.length}: ${evicted.map((id) => id.slice(0, 8)).join(', ')}`,
  );
  checks.check(
    'eviction: attachments reflect the swap',
    subscriptions.attachmentOf(firstId) === 'detached' &&
      subscriptions.attachmentOf(secondId) === 'live' &&
      agents.get(firstId).attachment === 'detached',
    `first=${subscriptions.attachmentOf(firstId)} second=${subscriptions.attachmentOf(secondId)}`,
  );

  // The payoff: liveness for an evicted agent still arrives, so only its transcript is lost.
  let lateStatus;
  try {
    lateStatus = await waitFor(
      events,
      (n) =>
        n.method === 'thread/status/changed' &&
        n.params?.threadId === firstId &&
        n.params.status.type === 'idle' &&
        events.indexOf(n) >= evictionMark,
      'post-eviction status for the evicted agent',
    );
  } catch (err) {
    checks.check('eviction: an evicted agent still reports status', false, String(err));
    return;
  }
  agents.applyStatus(firstId, lateStatus.params.status);
  checks.check(
    'eviction: an evicted agent still reports status',
    agents.get(firstId).status === 'completed',
    `status=${agents.get(firstId).status} attachment=${agents.get(firstId).attachment}`,
  );

  await subscriptions.detachAll();
}

/** Approval requests raised inside a sub-agent must name that sub-agent's thread. */
async function scenarioApproval({ client, events, approvalRequests, checks }) {
  const { agents, subscriptions } = newAgentState(client);
  const parentThreadId = await startRootTurn(client, MARK.approvalParent, {
    approvalPolicy: 'untrusted',
  });

  const activity = await waitForSpawn(events, parentThreadId, 'builder');
  const childThreadId = activity.agentThreadId;
  agents.recordActivity(parentThreadId, activity);
  const attached = await subscriptions.attach(childThreadId);
  if (attached) {
    agents.applyThread(attached.thread, attached.attachment);
  }

  let request;
  try {
    request = await waitFor(
      approvalRequests,
      (r) => r.params?.threadId === childThreadId,
      'approval request from the sub-agent',
      20000,
    );
  } catch {
    checks.check(
      'approval: a sub-agent command raises an approval naming its own thread',
      false,
      `no request for the child; saw ${approvalRequests.map((r) => r.method).join(', ') || 'none'}`,
    );
    await subscriptions.detachAll();
    return;
  }
  checks.check(
    'approval: a sub-agent command raises an approval naming its own thread',
    true,
    `${request.method}`,
  );
  checks.check(
    'approval: the request is not attributed to the root session',
    request.params.threadId !== parentThreadId,
  );

  await subscriptions.detachAll();
}

/**
 * Selecting an evicted agent's tab must reconnect it, and must not replay its transcript.
 *
 * This is what makes eviction acceptable: the cost of being dropped is bounded by the user
 * being able to get the agent back.
 */
async function scenarioRefocus({ client, events, checks }) {
  const { agents, subscriptions } = newAgentState(client);
  const parentThreadId = await startRootTurn(client, MARK.refocusParent);

  const activity = await waitForSpawn(events, parentThreadId, 'note_taker');
  const childThreadId = activity.agentThreadId;
  agents.recordActivity(parentThreadId, activity);
  const first = await subscriptions.attach(childThreadId);
  if (!checks.check('refocus: initial attach', Boolean(first))) {
    return;
  }
  agents.applyThread(first.thread, first.attachment);

  await waitFor(
    events,
    (n) => n.method === 'turn/completed' && n.params?.threadId === childThreadId,
    'child turn/completed',
  );
  const messagesOf = () =>
    events.filter(
      (n) =>
        n.method === 'item/completed' &&
        n.params?.threadId === childThreadId &&
        n.params.item?.type === 'agentMessage',
    ).length;
  const beforeRefocus = messagesOf();

  // Stand in for the LRU dropping this agent, then for the user selecting its tab.
  await subscriptions.detach(childThreadId);
  agents.setAttachment(childThreadId, 'detached');
  const again = await subscriptions.attach(childThreadId);
  checks.check(
    'refocus: an evicted agent can be re-attached',
    Boolean(again) && again.attachment === 'live',
    again ? `${again.attachment}` : 'returned undefined',
  );
  if (again) {
    agents.applyThread(again.thread, again.attachment);
    checks.check(
      'refocus: the registry reports the agent live again',
      agents.get(childThreadId).attachment === 'live',
    );
  }

  await sleep(1500);
  checks.check(
    're-attaching does not replay the transcript',
    messagesOf() === beforeRefocus,
    `${beforeRefocus} message(s) before, ${messagesOf()} after`,
  );

  await subscriptions.detachAll();
}

const SCENARIOS = [
  ['basics', scenarioBasics],
  ['nested', scenarioNested],
  ['eviction', scenarioEviction],
  ['approval', scenarioApproval],
  ['refocus', scenarioRefocus],
];

async function main() {
  const { server, port } = await startMockModelServer(SCRIPTS);
  const codexHome = makeCodexHome(port);
  log(`[setup] mock model on :${port}, CODEX_HOME=${codexHome}`);

  const { client, events, approvalRequests } = createClient(codexHome);
  const checks = new Checks();

  try {
    await client.request('initialize', {
      clientInfo: { name: 'e2e', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized', {});

    const only = process.env.E2E_ONLY;
    for (const [name, scenario] of SCENARIOS) {
      if (only && only !== name) {
        continue;
      }
      log(`\n--- ${name} ---`);
      await scenario({ client, events, approvalRequests, checks });
    }
  } finally {
    client.dispose?.();
    server.close();
  }

  if (checks.failures.length) {
    console.error(`\n${checks.failures.length} check(s) failed: ${checks.failures.join(', ')}`);
    process.exit(1);
  }
  log('\nAll checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
