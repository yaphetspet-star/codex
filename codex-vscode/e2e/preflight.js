/*
 * Checks that this machine and this working directory can run the review, and says exactly
 * what to do about anything missing.
 *
 * The failure it exists to prevent is an agent launched in some other workspace: `cd
 * codex-vscode` fails, and rather than stopping it starts searching the disk for a directory
 * that is not there. A check that names the problem is cheaper than a transcript of guesses.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
let fatal = false;

function check(name, run) {
  let outcome;
  try {
    outcome = run();
  } catch (err) {
    outcome = { ok: false, detail: String(err), fix: null };
  }
  results.push({ name, ...outcome });
  if (!outcome.ok) {
    fatal = true;
  }
}

check('工作目录', () => {
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return {
      ok: false,
      detail: `${process.cwd()} 下没有 package.json`,
      fix: '切到 codex 仓库的 codex-vscode 子目录再运行',
    };
  }
  const name = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
  if (name !== 'codex-vscode') {
    return {
      ok: false,
      detail: `当前目录是 "${name}" 项目，不是 codex-vscode`,
      fix: '切到 codex 仓库的 codex-vscode 子目录再运行',
    };
  }
  return { ok: true, detail: process.cwd() };
});

check('Node', () => {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 18
    ? { ok: true, detail: `v${process.versions.node}` }
    : { ok: false, detail: `v${process.versions.node} 过旧`, fix: '升级到 Node 18 以上' };
});

check('依赖', () => {
  const ok = fs.existsSync(path.join(process.cwd(), 'node_modules', '@playwright', 'test'));
  return ok
    ? { ok: true, detail: 'node_modules 已安装' }
    : { ok: false, detail: '缺少 node_modules', fix: 'npm ci' };
});

check('Playwright 浏览器', () => {
  // Installed outside the project, so `npm ci` does not bring it in.
  const root =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright');
  const found =
    fs.existsSync(root) && fs.readdirSync(root).some((d) => d.startsWith('chromium-'));
  return found
    ? { ok: true, detail: root }
    : { ok: false, detail: '未找到 chromium', fix: 'npx playwright install chromium' };
});

check('codex 二进制', () => {
  // The app-server comes from the installed Codex desktop app, not from PATH.
  let bin;
  try {
    ({ findCodexBin: bin } = require(path.join(process.cwd(), 'out', 'appServerClient.js')));
  } catch {
    return {
      ok: false,
      detail: 'out/ 尚未编译，无法定位',
      fix: 'npm run compile 后重跑本检查',
    };
  }
  try {
    return { ok: true, detail: bin() };
  } catch (err) {
    return { ok: false, detail: String(err), fix: '安装 Codex 桌面端' };
  }
});

/** Terminal columns, counting CJK as double width so the labels line up. */
const width = (s) => [...s].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uff60]/.test(c) ? 2 : 1), 0);

const pad = Math.max(...results.map((r) => width(r.name)));
console.log('');
for (const r of results) {
  const label = r.name + ' '.repeat(pad - width(r.name));
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${label}  ${r.detail}`);
  if (!r.ok && r.fix) {
    console.log(`${' '.repeat(pad + 8)}-> ${r.fix}`);
  }
}
console.log('');
if (fatal) {
  console.log('环境未就绪，先处理上面标 FAIL 的项，不要继续评审。');
  process.exit(1);
}
console.log('环境就绪，可以执行 npm test。');
