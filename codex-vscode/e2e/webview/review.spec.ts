/*
 * Renders the layouts a person would otherwise have to conjure by hand, measures them, and
 * writes screenshots plus a report.
 *
 * This is not a pass/fail suite. `ui.spec.ts` already asserts the things with right answers;
 * what is left in `docs/ui-review.md` are judgement calls, and a judgement call needs
 * evidence. Producing that evidence is mechanical, so it is automated here: the reviewer gets
 * measured numbers and pictures instead of having to drive ten agents by hand to see them.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  NARROW_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH,
  WebviewHarness,
  agentNode,
  type AgentNodeFixture,
} from './harness';

const OUT_DIR = path.resolve(__dirname, 'review');
const ROOT = 'thread-root';

/*
 * Drawn from `codex-rs/core/assets/agent/agent_names.txt`, the pool the engine actually
 * assigns from: 101 names, 4 to 13 characters. Tab width therefore varies in practice, which
 * a uniform `worker_N` fixture would hide. The long tail is over-represented here on purpose,
 * since crowding is decided by the worst case, not the average.
 */
const REAL_NICKNAMES = [
  'Chandrasekhar',
  'Schrodinger',
  'Kierkegaard',
  'Copernicus',
  'Heisenberg',
  'Archimedes',
  'Bernoulli',
  'Pasteur',
  'Hilbert',
  'Locke',
  'Volta',
  'Jason',
];

interface TabMeasurement {
  label: string;
  widthPx: number;
  truncated: boolean;
  fullyVisibleUnscrolled: boolean;
}

interface Finding {
  id: string;
  what: string;
  viewportWidth: number;
  screenshot: string;
  tabCount: number;
  stripScrollWidth: number;
  stripClientWidth: number;
  tabsVisibleUnscrolled: number;
  truncatedLabels: string[];
  tabs: TabMeasurement[];
  notes: string[];
}

const findings: Finding[] = [];

/** Measures every tab in the strip against the strip's own unscrolled viewport. */
async function measure(harness: WebviewHarness, page: import('@playwright/test').Page) {
  return page.locator('.agent-tabs').evaluate((strip) => {
    const stripBox = strip.getBoundingClientRect();
    const tabs = [...strip.querySelectorAll('.agent-tab')] as HTMLElement[];
    return {
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      tabs: tabs.map((t) => {
        const box = t.getBoundingClientRect();
        return {
          label: (t.textContent ?? '').trim(),
          widthPx: Math.round(box.width),
          // The button clips its own label once it hits max-width.
          truncated: t.scrollWidth > t.clientWidth + 1,
          fullyVisibleUnscrolled: box.left >= stripBox.left - 1 && box.right <= stripBox.right + 1,
        };
      }),
    };
  });
}

async function record(
  harness: WebviewHarness,
  page: import('@playwright/test').Page,
  id: string,
  what: string,
  viewportWidth: number,
  notes: string[] = [],
) {
  const m = await measure(harness, page);
  await harness.screenshot(path.join('..', 'review', id));
  findings.push({
    id,
    what,
    viewportWidth,
    screenshot: `${id}.png`,
    tabCount: m.tabs.length,
    stripScrollWidth: m.scrollWidth,
    stripClientWidth: m.clientWidth,
    tabsVisibleUnscrolled: m.tabs.filter((t) => t.fullyVisibleUnscrolled).length,
    truncatedLabels: m.tabs.filter((t) => t.truncated).map((t) => t.label),
    tabs: m.tabs,
    notes,
  });
}

function realAgents(count: number): AgentNodeFixture[] {
  return Array.from({ length: count }, (_, i) => {
    const nickname = REAL_NICKNAMES[i % REAL_NICKNAMES.length];
    return agentNode(`agent-${i + 1}`, ROOT, `/root/${nickname.toLowerCase()}`, { nickname });
  });
}

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test('R1: ten agents with real nicknames, comfortable side bar', async ({ page }) => {
  const harness = await WebviewHarness.open(page, SIDEBAR_WIDTH);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, realAgents(10));
  await record(harness, page, 'r1-ten-agents-380', '10 个子 agent，380px 边栏', SIDEBAR_WIDTH, [
    '判断：横向找一个特定 agent 是否已经不可行，需不需要下拉或搜索入口。',
  ]);
});

test('R2: ten agents, narrow side bar', async ({ page }) => {
  const harness = await WebviewHarness.open(page, NARROW_SIDEBAR_WIDTH);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, realAgents(10));
  await record(
    harness,
    page,
    'r2-ten-agents-260',
    '10 个子 agent，260px 窄边栏',
    NARROW_SIDEBAR_WIDTH,
    ['判断：窄边栏下主线程 tab 占掉多少比例，剩余空间还够不够用。'],
  );
});

test('R3: the strip scrolled to its far end', async ({ page }) => {
  const harness = await WebviewHarness.open(page, SIDEBAR_WIDTH);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, realAgents(10));
  await page.locator('.agent-tabs').evaluate((s) => (s.scrollLeft = s.scrollWidth));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await record(harness, page, 'r3-scrolled-end', '滚到最右，主线程 tab 被钉住', SIDEBAR_WIDTH, [
    '判断：sticky 的主线程 tab 压在其它 tab 上，视觉上是否自然、阴影是否突兀。',
  ]);
});

test('R4: three levels of nesting', async ({ page }) => {
  const harness = await WebviewHarness.open(page, SIDEBAR_WIDTH);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [
    agentNode('c1', ROOT, '/root/copernicus', { nickname: 'Copernicus' }),
    agentNode('c2', ROOT, '/root/hilbert', { nickname: 'Hilbert' }),
    agentNode('g1', 'c1', '/root/copernicus/pasteur', { nickname: 'Pasteur' }),
    agentNode('g2', 'c1', '/root/copernicus/volta', { nickname: 'Volta' }),
    agentNode('gg1', 'g1', '/root/copernicus/pasteur/locke', { nickname: 'Locke' }),
  ]);
  await record(harness, page, 'r4-nesting', '三层嵌套，5 个 agent 平铺在同一行', SIDEBAR_WIDTH, [
    '事实：tab 条不表达层级，父子关系只能靠 title 提示里的 agentPath 看出来。',
    '判断：这可接受吗；若不可接受，层级该怎么表达（缩进 / 分隔符 / 树形侧栏）。',
  ]);
});

test('R5: mixed lifecycle states side by side', async ({ page }) => {
  const harness = await WebviewHarness.open(page, SIDEBAR_WIDTH);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability();
  await harness.publishAgents(ROOT, [
    agentNode('a1', ROOT, '/root/locke', { nickname: 'Locke', status: 'running' }),
    agentNode('a2', ROOT, '/root/volta', { nickname: 'Volta', status: 'completed' }),
    agentNode('a3', ROOT, '/root/hilbert', { nickname: 'Hilbert', status: 'interrupted' }),
    agentNode('a4', ROOT, '/root/pasteur', {
      nickname: 'Pasteur',
      status: 'running',
      attachment: 'detached',
    }),
    agentNode('a5', ROOT, '/root/volta2', {
      nickname: 'Bernoulli',
      status: 'running',
      attachment: 'readOnly',
    }),
  ]);
  await record(harness, page, 'r5-states', '运行中 / 已完成 / 已中断 / 未订阅 / 只读 并列', SIDEBAR_WIDTH, [
    '判断：只看圆点能否区分五种状态；未订阅和只读在 tab 上完全看不出来，只在下方状态条里写着。',
  ]);
});

test('R6: the single-level degradation notice', async ({ page }) => {
  const harness = await WebviewHarness.open(page, SIDEBAR_WIDTH);
  await harness.openThread(ROOT, '主会话');
  await harness.publishCapability({ modelDeclaredVersion: null, nestedSpawnSupported: false });
  await harness.publishAgents(ROOT, realAgents(2));
  await record(harness, page, 'r6-degraded', '模型未声明 v2 时的降级提示', SIDEBAR_WIDTH, [
    '判断：这段话读得懂吗，用户看完知道该做什么吗（"换成声明 v2 的模型"够不够具体）。',
  ]);
});

test.afterAll(async () => {
  const lines: string[] = [
    '# 界面观察报告',
    '',
    '由 `npm run ui:review` 生成，不要手工编辑。',
    '',
    '这里只有客观测量和截图。需要判断的问题列在每节的「待判断」下，',
    '答案要写回 `docs/multi-agent-orchestration.md` §7。',
    '',
    `昵称取自引擎真实名字池（\`codex-rs/core/assets/agent/agent_names.txt\`，101 个，4–13 字符）。`,
    '',
  ];
  for (const f of findings) {
    const overflowRatio = (f.stripScrollWidth / f.stripClientWidth).toFixed(2);
    lines.push(
      `## ${f.id} — ${f.what}`,
      '',
      `![${f.id}](${f.screenshot})`,
      '',
      '| 测量项 | 值 |',
      '|---|---|',
      `| 边栏宽度 | ${f.viewportWidth}px |`,
      `| tab 总数（含主线程） | ${f.tabCount} |`,
      `| 不滚动能完整看到 | ${f.tabsVisibleUnscrolled} / ${f.tabCount} |`,
      `| tab 条内容宽 / 可视宽 | ${f.stripScrollWidth} / ${f.stripClientWidth} = ${overflowRatio}× |`,
      `| 标签被截断的 | ${f.truncatedLabels.length ? f.truncatedLabels.join('、') : '无'} |`,
      `| 单个 tab 宽度范围 | ${Math.min(...f.tabs.map((t) => t.widthPx))}–${Math.max(...f.tabs.map((t) => t.widthPx))}px |`,
      '',
    );
    if (f.notes.length) {
      lines.push('待判断：', '');
      for (const n of f.notes) {
        lines.push(`- ${n}`);
      }
      lines.push('');
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'measurements.json'),
    JSON.stringify(findings, null, 2),
    'utf8',
  );
  console.log(`\nReport written to ${path.join(OUT_DIR, 'report.md')}`);
});
