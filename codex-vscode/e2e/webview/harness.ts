/*
 * Drives the built webview bundle in a real browser.
 *
 * The panel is the half of the extension the app-server tests cannot reach: everything they
 * assert stops at the extension host. Here the React app runs for real, so tab routing,
 * status rendering and layout under pressure become observable facts rather than opinions.
 *
 * The page is the production `webview/dist` build with two things injected before it boots:
 * a stub for the VS Code bridge that records outgoing messages, and the subset of VS Code
 * theme variables the stylesheet reads.
 */
import { type Page, expect } from '@playwright/test';
import * as path from 'path';

/** Roughly the width of a comfortably sized VS Code side bar. */
export const SIDEBAR_WIDTH = 380;
/** A side bar narrow enough to be realistic for users who keep it tight. */
export const NARROW_SIDEBAR_WIDTH = 260;

/** The handful of theme variables `styles.css` reads without a fallback. */
const THEME_CSS = `
  :root {
    color-scheme: dark;
    --vscode-font-family: system-ui, sans-serif;
    --vscode-editor-font-family: ui-monospace, monospace;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-panel-border: #2b2b2b;
    --vscode-focusBorder: #0078d4;
    --vscode-editor-background: #1f1f1f;
    --vscode-sideBar-background: #181818;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-button-background: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #026ec1;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #04395e;
    --vscode-textLink-foreground: #4daafc;
    --vscode-charts-purple: #a371f7;
    --vscode-errorForeground: #f85149;
  }
  html, body { margin: 0; padding: 0; height: 100%; background: #181818; }
`;

/** Mirrors the host's `AgentNode`; see `src/agents/registry.ts`. */
export interface AgentNodeFixture {
  threadId: string;
  parentThreadId: string;
  agentPath: string;
  status: 'running' | 'completed' | 'interrupted' | 'unknown';
  attachment: 'detached' | 'live' | 'readOnly';
  nickname: string | null;
  role: string | null;
  cwd: string | null;
  canAcceptDirectInput: boolean;
  updatedAt: number;
}

export function agentNode(
  threadId: string,
  parentThreadId: string,
  agentPath: string,
  overrides: Partial<AgentNodeFixture> = {},
): AgentNodeFixture {
  return {
    threadId,
    parentThreadId,
    agentPath,
    status: 'running',
    attachment: 'live',
    nickname: null,
    role: null,
    cwd: null,
    canAcceptDirectInput: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

export class WebviewHarness {
  constructor(private readonly page: Page) {}

  /** Boots the panel at the given width and waits for React to mount. */
  static async open(page: Page, width = SIDEBAR_WIDTH): Promise<WebviewHarness> {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const posted: unknown[] = [];
      (window as unknown as Record<string, unknown>).__posted = posted;
      (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => posted.push(m),
        getState: () => undefined,
        setState: () => undefined,
      });
    });
    await page.goto('/');
    await page.addStyleTag({ content: THEME_CSS });
    await expect(page.locator('.app')).toBeVisible();
    return new WebviewHarness(page);
  }

  /** Delivers a host->webview message exactly as the extension would. */
  async send(message: Record<string, unknown>): Promise<void> {
    await this.page.evaluate((m) => window.postMessage(m, '*'), message);
    // One frame is enough for React to flush the resulting state update.
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }

  /** Messages the panel sent back to the host, in order. */
  postedMessages(): Promise<Record<string, unknown>[]> {
    return this.page.evaluate(
      () => (window as unknown as { __posted: Record<string, unknown>[] }).__posted,
    );
  }

  /** Opens a thread and makes it the active top-level tab. */
  async openThread(threadId: string, title = 'Session'): Promise<void> {
    await this.send({ type: 'threadOpened', threadId, title });
  }

  /** Publishes the agent tree snapshot, which is the only agent signal the panel gets. */
  async publishAgents(rootThreadId: string, nodes: AgentNodeFixture[]): Promise<void> {
    await this.send({ type: 'agentTree', rootThreadId, nodes });
  }

  /** Reports the multi-agent runtime, as `activateMultiAgent` does on startup. */
  async publishCapability(overrides: Record<string, unknown> = {}): Promise<void> {
    await this.send({
      type: 'multiAgent',
      active: true,
      modelDeclaredVersion: 'v2',
      nestedSpawnSupported: true,
      ...overrides,
    });
  }

  /** Appends assistant text to a thread, the way streaming deltas arrive. */
  async say(threadId: string, text: string): Promise<void> {
    await this.send({ type: 'delta', threadId, text });
  }

  agentTabs() {
    return this.page.locator('.agent-tab');
  }

  /** Visible labels of the nested tab strip, including the leading parent tab. */
  async agentTabLabels(): Promise<string[]> {
    return this.agentTabs().allInnerTexts();
  }

  async clickAgentTab(label: string): Promise<void> {
    await this.agentTabs().filter({ hasText: label }).first().click();
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }

  /** Text of the transcript area, which switches with the selected nested tab. */
  transcriptText(): Promise<string> {
    return this.page.locator('.log').innerText();
  }

  /** Status dot classes in tab order, e.g. `s-running`. */
  async statusDots(): Promise<string[]> {
    return this.page.locator('.agent-dot').evaluateAll((nodes) =>
      nodes.map((n) => [...n.classList].find((c) => c.startsWith('s-')) ?? ''),
    );
  }

  /**
   * Whether the tab strip scrolls horizontally, and whether its first tab stays reachable
   * without scrolling. `/many` is the case this exists for.
   */
  async tabStripMetrics(): Promise<{
    overflows: boolean;
    scrollWidth: number;
    clientWidth: number;
    firstTabFullyVisible: boolean;
    wrapped: boolean;
  }> {
    return this.page.locator('.agent-tabs').evaluate((strip) => {
      const first = strip.querySelector('.agent-tab') as HTMLElement | null;
      const stripBox = strip.getBoundingClientRect();
      const firstBox = first?.getBoundingClientRect();
      const tabs = [...strip.querySelectorAll('.agent-tab')] as HTMLElement[];
      const tops = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)));
      return {
        overflows: strip.scrollWidth > strip.clientWidth + 1,
        scrollWidth: strip.scrollWidth,
        clientWidth: strip.clientWidth,
        firstTabFullyVisible: Boolean(
          firstBox && firstBox.left >= stripBox.left - 1 && firstBox.right <= stripBox.right + 1,
        ),
        // More than one row means the strip grew vertically instead of scrolling.
        wrapped: tops.size > 1,
      };
    });
  }

  /** The note in the bar under the transcript, which explains the selected agent's state. */
  agentBarNote(): Promise<string> {
    return this.page.locator('.agent-bar-note').innerText();
  }

  async screenshot(name: string): Promise<void> {
    await this.page.screenshot({
      path: path.resolve(__dirname, 'screenshots', `${name}.png`),
      fullPage: false,
    });
  }
}
