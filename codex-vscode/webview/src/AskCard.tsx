import { useState } from 'react';
import { post, type Question } from './vscodeApi';

/**
 * Renders a blocking question from the agent (item/tool/requestUserInput).
 * The turn stays suspended until the user answers, so this must always be
 * actionable - otherwise the conversation deadlocks.
 */
export function AskCard({ requestId, questions }: { requestId: string; questions: Question[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return <div className="ask ask-done">已回答</div>;
  }

  const submit = () => {
    const payload: Record<string, { answers: string[] }> = {};
    for (const q of questions) {
      const v = answers[q.id];
      if (v) {
        payload[q.id] = { answers: [v] };
      }
    }
    post({ type: 'answer', requestId, answers: payload });
    setSubmitted(true);
  };

  return (
    <div className="ask">
      <div className="ask-title">Codex 提问</div>
      {questions.map((q) => (
        <div key={q.id} className="ask-item">
          {q.header ? <div className="ask-header">{q.header}</div> : null}
          <div className="ask-question">{q.question}</div>
          <div className="ask-options">
            {(q.options ?? []).map((o) => (
              <button
                key={o.label}
                className={'ask-option' + (answers[q.id] === o.label ? ' selected' : '')}
                title={o.description}
                onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.label }))}
              >
                {o.label}
              </button>
            ))}
            {q.isOther ? (
              <input
                className="ask-input"
                placeholder="其他…"
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
            ) : null}
          </div>
        </div>
      ))}
      <button className="ask-submit" onClick={submit}>
        提交
      </button>
    </div>
  );
}
