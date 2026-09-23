import { useMemo } from 'react';
import { marked } from 'marked';
// Register only the languages we care about: importing all of highlight.js
// inflates the webview bundle past 1MB.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { post } from './vscodeApi';

const LANGUAGES: Record<string, unknown> = {
  bash,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  xml,
  yaml,
};
for (const [name, impl] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, impl as never);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// Render code blocks with copy / insert-to-editor actions.
const renderer = new marked.Renderer();
renderer.code = (code: string, lang?: string) => {
  let highlighted: string;
  try {
    highlighted =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
  } catch {
    highlighted = escapeHtml(code);
  }
  const label = lang || 'code';
  return (
    `<div class="code-block">` +
    `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
    `<button class="code-btn" data-copy>复制</button>` +
    `<button class="code-btn" data-insert>插入编辑器</button></div>` +
    `<pre><code class="hljs">${highlighted}</code></pre>` +
    `</div>`
  );
};

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      return marked.parse(text ?? '', { renderer });
    } catch {
      return escapeHtml(text ?? '');
    }
  }, [text]);

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-copy') && !target.hasAttribute('data-insert')) {
      return;
    }
    const block = target.closest('.code-block');
    const code = block?.querySelector('pre code')?.textContent ?? '';
    if (target.hasAttribute('data-copy')) {
      void navigator.clipboard?.writeText(code);
    } else {
      post({ type: 'insertCode', code });
    }
  };

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} onClick={onClick} />;
}
