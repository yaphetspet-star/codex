/*
 * Panel behaviour under multi-agent load.
 *
 * These cover the objectively checkable half of `docs/ui-review.md`; the cases left for
 * a person are the ones that ask how something feels, not what it does.
 */
import { expect, test } from '@playwright/test';
import {
  NARROW_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH,
  WebviewHarness,
  agentNode,
} from './harness';

const ROOT = 'thread-root';

/** Opens a session that already has `count` running agents. */
async function sessionWithAgents(harness: WebviewHarness, count: number) {
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  const nodes = Array.from({ length: count }, (_, i) =>
    agentNode(`agent-${i + 1}`, ROOT, `/root/worker_${i + 1}`),
  );
  await harness.publishAgents(ROOT, nodes);
  return nodes;
}

test('C1: a single agent renders its own transcript and controls', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.say(ROOT, 'parent thread is talking');
  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/reviewer', { nickname: 'Kepler' }),
  ]);

  await expect(harness.agentTabs()).toHaveCount(2);
  expect(await harness.agentTabLabels()).toEqual(['主线程', 'Kepler']);
  expect(await harness.statusDots()).toEqual(['s-running']);

  // The agent's own output must not leak into the parent transcript, or vice versa.
  await harness.say('agent-1', 'reviewer is working');
  expect(await harness.transcriptText()).toContain('parent thread is talking');
  expect(await harness.transcriptText()).not.toContain('reviewer is working');

  await harness.clickAgentTab('Kepler');
  expect(await harness.transcriptText()).toContain('reviewer is working');
  expect(await harness.transcriptText()).not.toContain('parent thread is talking');
  expect(await harness.agentBarNote()).toContain('无法直接输入');

  await harness.clickAgentTab('主线程');
  expect(await harness.transcriptText()).toContain('parent thread is talking');

  await harness.screenshot('c1-single-agent');
});

test('C1: status dots follow the tree snapshot', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [agentNode('agent-1', ROOT, '/root/reviewer')]);
  expect(await harness.statusDots()).toEqual(['s-running']);

  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/reviewer', { status: 'completed' }),
  ]);
  expect(await harness.statusDots()).toEqual(['s-completed']);

  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/reviewer', { status: 'interrupted' }),
  ]);
  expect(await harness.statusDots()).toEqual(['s-interrupted']);
});

test('C3: three concurrent agents keep separate transcripts', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [
    agentNode('a1', ROOT, '/root/reviewer'),
    agentNode('a2', ROOT, '/root/tester'),
    agentNode('a3', ROOT, '/root/documenter'),
  ]);
  await harness.say('a1', 'review notes');
  await harness.say('a2', 'test results');
  await harness.say('a3', 'doc draft');

  for (const [label, own, foreign] of [
    ['reviewer', 'review notes', 'test results'],
    ['tester', 'test results', 'doc draft'],
    ['documenter', 'doc draft', 'review notes'],
  ] as const) {
    await harness.clickAgentTab(label);
    const text = await harness.transcriptText();
    expect(text).toContain(own);
    expect(text).not.toContain(foreign);
  }

  await harness.screenshot('c3-three-agents');
});

test('C3: a newly finished agent does not steal the selected tab', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  const nodes = await sessionWithAgents(harness, 3);
  await harness.clickAgentTab('worker_2');

  await harness.publishAgents(ROOT, [
    { ...nodes[0], status: 'completed' },
    nodes[1],
    nodes[2],
  ]);
  await expect(page.locator('.agent-tab.active')).toHaveText(/worker_2/);
});

test('C4: ten agents scroll the tab strip instead of breaking the layout', async ({ page }) => {
  const harness = await WebviewHarness.open(page, SIDEBAR_WIDTH);
  await sessionWithAgents(harness, 10);

  const metrics = await harness.tabStripMetrics();
  expect(metrics.overflows).toBe(true);
  // Wrapping would push the transcript down and grow without bound.
  expect(metrics.wrapped).toBe(false);
  // The parent tab is the way back to the main conversation; it must not need scrolling.
  expect(metrics.firstTabFullyVisible).toBe(true);

  // The panel itself must not gain a horizontal scrollbar.
  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(bodyOverflow).toBe(true);

  await harness.screenshot('c4-ten-agents');
});

test('C4: the tab strip survives a narrow side bar', async ({ page }) => {
  const harness = await WebviewHarness.open(page, NARROW_SIDEBAR_WIDTH);
  await sessionWithAgents(harness, 10);

  const metrics = await harness.tabStripMetrics();
  expect(metrics.wrapped).toBe(false);
  expect(metrics.firstTabFullyVisible).toBe(true);
  await harness.screenshot('c4-ten-agents-narrow');
});

test('C4: the parent tab stays reachable after scrolling to the far end', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await sessionWithAgents(harness, 10);

  // Getting to the last agent is the normal way to end up scrolled right; the way back to
  // the main conversation must not require scrolling back.
  await page.locator('.agent-tabs').evaluate((s) => (s.scrollLeft = s.scrollWidth));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  const metrics = await harness.tabStripMetrics();
  await harness.screenshot('c4-scrolled-to-end');
  expect(metrics.firstTabFullyVisible).toBe(true);
});

test('C4: a tab reached by scrolling still switches the transcript', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await sessionWithAgents(harness, 10);
  await harness.say('agent-10', 'last worker output');

  await harness.clickAgentTab('worker_10');
  expect(await harness.transcriptText()).toContain('last worker output');
});

test('C5: selecting an agent tab asks the host to re-attach it', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/worker_1', {
      status: 'completed',
      attachment: 'detached',
    }),
  ]);

  await harness.clickAgentTab('worker_1');
  const posted = await harness.postedMessages();
  expect(posted).toContainEqual({ type: 'focusAgent', threadId: 'agent-1' });
});

test('C5: a detached agent says so, and a read-only one is distinguishable', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/worker_1', { attachment: 'detached' }),
  ]);
  await harness.clickAgentTab('worker_1');
  expect(await harness.agentBarNote()).toContain('重新连接');

  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/worker_1', { attachment: 'readOnly' }),
  ]);
  expect(await harness.agentBarNote()).toContain('只读');

  await harness.publishAgents(ROOT, [
    agentNode('agent-1', ROOT, '/root/worker_1', { attachment: 'live' }),
  ]);
  expect(await harness.agentBarNote()).toContain('无法直接输入');
});

test('C5: re-attaching does not duplicate what is already on screen', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  const detached = agentNode('agent-1', ROOT, '/root/worker_1', { attachment: 'detached' });
  await harness.publishAgents(ROOT, [detached]);
  await harness.say('agent-1', 'unique-line');
  await harness.clickAgentTab('worker_1');

  // The host re-attaches and republishes the tree; no transcript events are replayed.
  await harness.publishAgents(ROOT, [{ ...detached, attachment: 'live' }]);
  const occurrences = (await harness.transcriptText()).split('unique-line').length - 1;
  expect(occurrences).toBe(1);
});

test('C6: a grandchild appears in the strip and its path is discoverable', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [
    agentNode('child', ROOT, '/root/researcher'),
    agentNode('grandchild', 'child', '/root/researcher/scraper'),
  ]);

  expect(await harness.agentTabLabels()).toEqual(['主线程', 'researcher', 'scraper']);
  // Depth is not encoded in the strip, so the tooltip is the only way to see the hierarchy.
  await expect(harness.agentTabs().nth(2)).toHaveAttribute(
    'title',
    '/root/researcher/scraper',
  );

  await harness.clickAgentTab('scraper');
  expect(await harness.agentBarNote()).toBeTruthy();
  await harness.screenshot('c6-nested');
});

test('C9: switching sessions does not leak agents between them', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '会话一');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [agentNode('agent-1', ROOT, '/root/worker_1')]);
  await expect(harness.agentTabs()).toHaveCount(2);

  await harness.openThread('thread-two', '会话二');
  await page.locator('.tab', { hasText: '会话二' }).click();
  await harness.publishAgents('thread-two', []);
  await expect(harness.agentTabs()).toHaveCount(0);
});

test('C9: closing a session clears its agent strip', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [agentNode('agent-1', ROOT, '/root/worker_1')]);
  await expect(harness.agentTabs()).toHaveCount(2);

  await harness.send({ type: 'threadClosed', threadId: ROOT });
  await expect(harness.agentTabs()).toHaveCount(0);
});

test('C10: a model without v2 is called out as single-level only', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability({
    modelDeclaredVersion: null,
    nestedSpawnSupported: false,
  });
  await harness.publishAgents(ROOT, [agentNode('agent-1', ROOT, '/root/worker_1')]);

  await expect(page.locator('.agent-notice')).toContainText('无法再往下派发');
  await harness.screenshot('c10-degraded');
});

test('C10: an engine that will not run v2 says so instead of staying blank', async ({ page }) => {
  const harness = await WebviewHarness.open(page);
  await harness.openThread(ROOT, '主会话');
  // No agents are published: without v2 none would ever arrive, which is the whole point.
  await harness.publishCapability({
    active: false,
    modelDeclaredVersion: 'v1',
    nestedSpawnSupported: false,
  });

  await expect(page.locator('.agent-notice')).toContainText('无法启用 multi-agent v2');
});
