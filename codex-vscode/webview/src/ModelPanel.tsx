import { useState } from 'react';
import { post, type CustomModel } from './vscodeApi';

interface Props {
  builtin: { id: string; name: string }[];
  custom: CustomModel[];
  current: { model: string; provider: string };
  onClose: () => void;
}

/**
 * Compact popover anchored above the input bar (like a dropdown menu).
 * Clicking anywhere outside closes it via the transparent backdrop.
 */
export function ModelPanel({ builtin, custom, current, onClose }: Props) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ baseUrl: '', apiKey: '', modelName: '' });

  const backdrop = <div className="popover-backdrop" onClick={onClose} />;

  if (adding) {
    const valid = form.baseUrl.trim() && form.apiKey.trim() && form.modelName.trim();
    const save = () => {
      if (!valid) {
        return;
      }
      post({ type: 'addModel', ...form });
      onClose();
    };
    const field = (label: string, key: keyof typeof form, placeholder: string, type = 'text') => (
      <div className="am-field">
        <label>{label}</label>
        <input
          type={type}
          value={form[key]}
          placeholder={placeholder}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        />
      </div>
    );
    return (
      <>
        {backdrop}
        <div className="model-popover">
          <div className="popover-title">Add Model（OpenAI 兼容 API）</div>
          <div className="popover-body">
            {field('Base URL', 'baseUrl', 'https://api.example.com/v1')}
            {field('API Key', 'apiKey', 'sk-...', 'password')}
            {field('Model ID', 'modelName', '如 glm-5.3-external')}
          </div>
          <div className="popover-actions">
            <button className="ghost" onClick={() => setAdding(false)}>
              取消
            </button>
            <button className="primary" disabled={!valid} onClick={save}>
              Save
            </button>
          </div>
        </div>
      </>
    );
  }

  const row = (key: string, label: string, model: string, provider: string) => {
    const selected = current.model === model && current.provider === provider;
    return (
      <button
        key={key}
        className="model-item"
        onClick={() => {
          post({ type: 'selectModel', model, provider });
          onClose();
        }}
      >
        <span className="model-name">
          {label}
          {selected ? ' ✓' : ''}
        </span>
      </button>
    );
  };

  return (
    <>
      {backdrop}
      <div className="model-popover">
        <div className="popover-body">
          {current.model ? (
            <div className="model-current">
              当前：{current.model || '(默认)'}
              {current.provider ? `（${current.provider}）` : ''}
            </div>
          ) : null}
          {builtin.length > 0 ? (
            <>
              <div className="model-group">Built-In Models</div>
              {builtin.map((m) => row(`b-${m.id}`, m.name, m.id, ''))}
            </>
          ) : null}
          <div className="model-group">我的模型</div>
          {custom.length === 0 ? (
            <div className="dim model-empty">（暂无自定义模型）</div>
          ) : (
            custom.map((m) => row(`c-${m.key}`, m.model, m.model, m.providerId))
          )}
        </div>
        <div className="popover-actions">
          <button className="ghost" onClick={() => post({ type: 'openConfig' })}>
            Open Config
          </button>
          <button className="primary" onClick={() => setAdding(true)}>
            Add Custom Model
          </button>
        </div>
      </div>
    </>
  );
}
