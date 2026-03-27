import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createClient } from 'graphql-sse';

// ─── Markdown renderer ────────────────────────────────────────────────────────
function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0"/>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;margin:14px 0 2px">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:700;margin:12px 0 2px;color:#111827">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:600;margin:10px 0 2px;color:#374151">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px;font-family:monospace">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#16a34a;text-decoration:underline">$1</a>');
  html = html.replace(/((?:^[ \t]*[*\-•] .+\n?)+)/gm, (block) => {
    const items = block.split('\n').filter(l => l.trim())
      .map(l => `<li style="margin:3px 0">${l.replace(/^[ \t]*[*\-•] /, '')}</li>`).join('');
    return `<ul style="margin:10px 0 10px 20px;padding:0;list-style:disc">${items}</ul>`;
  });
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block.split('\n').filter(l => l.trim())
      .map(l => `<li style="margin:3px 0">${l.replace(/^[ \t]*\d+\. /, '')}</li>`).join('');
    return `<ol style="margin:10px 0 10px 20px;padding:0">${items}</ol>`;
  });
  html = html.split(/\n{2,}/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|hr|pre)/.test(t)) return t;
    return `<p style="margin:10px 0;line-height:1.8">${t.replace(/\n/g, ' ')}</p>`;
  }).join('\n');
  return html;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface ToolEvent {
  type: 'tool_start' | 'tool_result';
  tool_call_id: string;
  tool_name: string;
  display_name?: string;
  arguments?: Record<string, any>;
  success?: boolean;
  summary?: string;
}

interface CourseCardData {
  title: string;
  description: string;
  subject: string;
  difficulty: string;
  target_audience: string;
  suggested_price: number;
  currency: string;
  thumbnail_query: string;
  thumbnail?: string;         // base64 AI-generated thumbnail (when available)
  thumbnailMime?: string;     // mime type for the base64 thumbnail
  thumbnailLoading?: boolean; // true while thumbnail is still generating
  total_sections: number;
  total_lessons: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolEvents: ToolEvent[];
  courseCard?: CourseCardData;
  coursePayload?: any;
  courseCreated?: boolean;
  done: boolean;
  error?: boolean;
}

// ─── API config ───────────────────────────────────────────────────────────────
const AGENT_API = 'http://localhost:3001/admin-ai/stream';
const LEARNYST_API = 'http://localhost:3001/api/courses';
const AUTH_TOKEN = `Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJPbmxpbmUgSldUIEJ1aWxkZXIiLCJpYXQiOlsxNzcwMDk4NjAwLCIxNzcwMDI0NjYzIl0sImV4cCI6MTgwMTYzNDYwMCwiYXVkIjoid3d3LmV4YW1wbGUuY29tIiwic3ViIjoianJvY2tldEBleGFtcGxlLmNvbSIsInNjaG9vbF9pZCI6MTUyNDMyLCJsZXNzb25faWQiOjQ2MTM4NTgsInVzZXJfaWQiOjkwODIyMSwidXNlcl9uYW1lIjoiYWthc2grYm90MiIsImlzX2FpX2NoYXRfYXZhaWxhYmxlIjp0cnVlLCJ0eXAiOiJKV1QiLCJpc3NydiI6dHJ1ZX0.PgPMTN_w0tCGCrsxNjNrqED3fzWcFovBqfT9i0byNIc`;

const sseClient = createClient({
  url: AGENT_API,
  headers: { Authorization: AUTH_TOKEN },
});

// ─── Page resource presets ────────────────────────────────────────────────────
interface PageResource {
  pageName: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
}

const PAGE_PRESETS: { label: string; value: PageResource[] | null }[] = [
  { label: 'None', value: null },
  {
    label: 'Course',
    value: [
      { pageName: 'courseDashboard', resourceType: 'course', resourceId: '12345', resourceName: 'Advanced React Development' },
    ],
  },
  {
    label: 'Lesson',
    value: [
      { pageName: 'lessonDashboard', resourceType: 'lesson', resourceId: '4613858', resourceName: 'React Hooks Deep Dive' },
      { pageName: 'lessonDashboard', resourceType: 'course', resourceId: '12345', resourceName: 'Advanced React Development' },
    ],
  },
  {
    label: 'Bundle',
    value: [
      { pageName: 'bundleDashboard', resourceType: 'bundle', resourceId: '678', resourceName: 'Full Stack Mastery Bundle' },
    ],
  },
];

// ─── Spinner ──────────────────────────────────────────────────────────────────
const Spinner: React.FC<{ color?: string; size?: number }> = ({ color = '#16a34a', size = 12 }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke={color} strokeWidth='2.5'
    style={{ animation: 'aui-spin 1s linear infinite', flexShrink: 0 }}>
    <style>{`@keyframes aui-spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }`}</style>
    <path d='M21 12a9 9 0 11-6.219-8.56'/>
  </svg>
);

// ─── Course creation wizard ───────────────────────────────────────────────────
interface WizardQuestion {
  field: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  customPlaceholder?: string;
}


function buildCoursePrompt(answers: Record<string, string>): string {
  const parts: string[] = [];
  if (answers.topic) parts.push(`Course topic: ${answers.topic}`);
  if (answers.audience) parts.push(`Target audience: ${answers.audience}`);
  if (answers.difficulty) parts.push(`Difficulty: ${answers.difficulty}`);
  if (answers.access) parts.push(`Content security: ${answers.access.startsWith('Encrypted') ? 'encrypted' : 'unencrypted'}`);
  if (answers.pricing) parts.push(`Pricing: ${answers.pricing === 'Free' ? 'free' : `paid at ${answers.pricing}`}`);
  return parts.join('. ') + '.';
}

const CourseWizard: React.FC<{ onComplete: (msg: string) => void; onClose: () => void; fields: WizardQuestion[] }> = ({ onComplete, onClose, fields }) => {
  const questions = fields;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState('');
  const q = questions[step];
  const isLast = step === questions.length - 1;

  const handleSelect = (value: string) => {
    const next = { ...answers, [q.field]: value };
    setCustom('');
    if (isLast) { onComplete(buildCoursePrompt(next)); }
    else { setAnswers(next); setStep(s => s + 1); }
  };

  const handleCustomSubmit = () => { if (custom.trim()) handleSelect(custom.trim()); };

  if (!q) return null;

  return (
    <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', border: '1px solid #e5e7eb' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 16px' }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>{q.question}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#9ca3af' }}>
              <button onClick={() => step > 0 && setStep(s => s - 1)} disabled={step === 0} style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: step > 0 ? 'pointer' : 'default', color: step > 0 ? '#6b7280' : '#d1d5db', display: 'flex', alignItems: 'center' }}>
                <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'><polyline points='15 18 9 12 15 6'/></svg>
              </button>
              <span>{step + 1} of {questions.length}</span>
              <span style={{ color: '#d1d5db', display: 'flex', alignItems: 'center' }}>
                <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'><polyline points='9 18 15 12 9 6'/></svg>
              </span>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
          </div>
        </div>

        {/* Options */}
        <div style={{ padding: '0 16px' }}>
          {q.options.map((opt, i) => (
            <button key={opt} onClick={() => handleSelect(opt)} style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '13px 12px', marginBottom: 4, background: 'none', border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontSize: 14, color: '#111827', transition: 'background 0.1s' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              <span style={{ width: 26, height: 26, borderRadius: 8, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>{i + 1}</span>
              {opt}
            </button>
          ))}
        </div>

        {/* Custom input */}
        {q.allowCustom && (
          <div style={{ margin: '8px 16px 0', display: 'flex', alignItems: 'center', gap: 8, background: '#f9fafb', borderRadius: 10, padding: '10px 12px', border: '1px solid #f3f4f6' }}>
            <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#9ca3af' strokeWidth='2'><path d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'/><path d='M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'/></svg>
            <input value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
              placeholder={q.customPlaceholder ?? 'Type a custom answer…'}
              style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: '#111827', fontFamily: 'inherit' }} />
            <button onClick={handleCustomSubmit} disabled={!custom.trim()}
              style={{ width: 28, height: 28, borderRadius: '50%', background: custom.trim() ? '#4f46e5' : '#e5e7eb', border: 'none', cursor: custom.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.15s' }}>
              <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='#fff' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'><line x1='12' y1='19' x2='12' y2='5'/><polyline points='5 12 12 5 19 12'/></svg>
            </button>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '12px 24px', textAlign: 'center', fontSize: 12, color: '#9ca3af' }}>Uses AI. Verify result.</div>
    </div>
  );
};

// ─── Tool activity feed ───────────────────────────────────────────────────────
function toolSummary(ev: ToolEvent): string {
  return ev.arguments?.title ?? ev.arguments?.name ?? ev.arguments?.query ?? ev.arguments?.prompt ?? '';
}

const ToolFeed: React.FC<{ events: ToolEvent[]; done: boolean }> = ({ events, done }) => {
  const [expanded, setExpanded] = useState(false);
  const starts = events.filter(e => e.type === 'tool_start');
  const results = new Map(events.filter(e => e.type === 'tool_result').map(e => [e.tool_call_id, e]));
  const pairs = starts.map(start => ({ start, result: results.get(start.tool_call_id) }));
  if (pairs.length === 0) return null;
  const completed = pairs.filter(p => p.result).length;
  return (
    <div style={{ marginBottom: 10 }}>
      <button onClick={() => setExpanded(e => !e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', fontSize: 12, color: '#15803d', fontFamily: 'inherit' }}>
        {!done ? <Spinner /> : <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='#16a34a' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>}
        <span style={{ fontWeight: 600 }}>{done ? `${completed} actions completed` : `Running… ${completed}/${pairs.length}`}</span>
        <svg width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}><polyline points='6 9 12 15 18 9'/></svg>
      </button>
      {expanded && (
        <div style={{ marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', fontSize: 12 }}>
          {pairs.map((pair, i) => {
            const isRunning = !pair.result;
            const failed = pair.result?.success === false;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', borderBottom: i < pairs.length - 1 ? '1px solid #f3f4f6' : 'none', background: '#fff' }}>
                <div style={{ marginTop: 1, flexShrink: 0 }}>
                  {isRunning ? <Spinner /> : failed
                    ? <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#dc2626' strokeWidth='2'><circle cx='12' cy='12' r='10'/><line x1='15' y1='9' x2='9' y2='15'/><line x1='9' y1='9' x2='15' y2='15'/></svg>
                    : <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#16a34a' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: '#374151' }}>{pair.start.display_name ?? pair.start.tool_name}</span>
                  {toolSummary(pair.start) && <span style={{ color: '#6b7280', marginLeft: 6 }}>— {toolSummary(pair.start)}</span>}
                  {failed && pair.result?.summary && <div style={{ color: '#dc2626', marginTop: 2 }}>{pair.result.summary}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Preview panel course card ────────────────────────────────────────────────
const PreviewPanel: React.FC<{
  card: CourseCardData;
  coursePayload?: any;
  courseCreated?: boolean;
  isStreaming: boolean;
  onCreateCourse: (card: CourseCardData, price: number) => Promise<void>;
  onCourseCreated: () => void;
  onClose: () => void;
}> = ({ card, coursePayload, courseCreated, isStreaming, onCreateCourse, onCourseCreated, onClose }) => {
  const price = card.suggested_price;
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [learnystLoading, setLearnystLoading] = useState(false);
  const [learnystError, setLearnystError] = useState('');
  const PLACEHOLDER = 'https://blogcdn.visionias.in/wp-content-prod/2024/03/20.-UPSC-Mains-GS-2-Syllabus-and-PYQs-Trends-2.webp';
  const thumbSrc = card.thumbnail
    ? `data:${card.thumbnailMime ?? 'image/png'};base64,${card.thumbnail}`
    : card.thumbnail_query
      ? `https://source.unsplash.com/640x300/?${encodeURIComponent(card.thumbnail_query)}`
      : PLACEHOLDER;
  const thumbLoading = card.thumbnailLoading && !card.thumbnail;
  const currency = card.currency === 'INR' ? '₹' : card.currency;

  // Reset status when card changes
  useEffect(() => { setCreateStatus('idle'); }, [card.suggested_price]);

  const handleCreateCourse = async () => {
    setCreating(true);
    try {
      await onCreateCourse(card, price);
      setCreateStatus('success');
    } catch {
      setCreateStatus('error');
    } finally {
      setCreating(false);
    }
  };

  const handleLearnystCreate = async () => {
    if (!coursePayload) return;
    setLearnystLoading(true);
    setLearnystError('');
    try {
      const res = await fetch(LEARNYST_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH_TOKEN },
        body: JSON.stringify(coursePayload),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      onCourseCreated();
    } catch (err: any) {
      setLearnystError(err?.message ?? 'Failed');
    } finally {
      setLearnystLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Panel header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Preview</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4, display: 'flex', lineHeight: 1 }}>
          <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><line x1='18' y1='6' x2='6' y2='18'/><line x1='6' y1='6' x2='18' y2='18'/></svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 16px' }}>
        {/* Thumbnail */}
        <div style={{ height: 180, background: '#f3f4f6', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
          <img src={thumbLoading ? PLACEHOLDER : thumbSrc} alt={card.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', filter: thumbLoading ? 'blur(8px)' : 'none', transform: thumbLoading ? 'scale(1.05)' : 'none', transition: 'filter 0.4s, transform 0.4s' }}
            onError={e => { (e.target as HTMLImageElement).src = PLACEHOLDER; }} />
          {thumbLoading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.25)' }}>
              <Spinner />
              <span style={{ color: '#fff', fontSize: 12, fontWeight: 600, letterSpacing: 0.3 }}>Generating thumbnail…</span>
            </div>
          )}
        </div>

        <div style={{ padding: '16px 16px 0' }}>
          {/* Title */}
          <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', lineHeight: 1.4, marginBottom: 6 }}>{card.title}</div>

          {/* Description */}
          {card.description && (
            <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, marginBottom: 12 }}>{card.description}</div>
          )}

          {/* Stat badges */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {[
              { icon: '📚', v: `${card.total_sections} sections` },
              { icon: '🎓', v: `${card.total_lessons} lessons` },
              { icon: '📊', v: card.difficulty },
              { icon: '👥', v: card.target_audience },
            ].map(({ icon, v }) => v ? (
              <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 20, padding: '3px 10px', fontSize: 12, color: '#374151' }}>
                {icon} {v}
              </span>
            ) : null)}
          </div>

          {/* Price */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 2 }}>Price ({card.currency})</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{currency}{price.toLocaleString()}</div>
          </div>

          {/* Create structure button */}
          {createStatus === 'success' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#16a34a', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>
              Structure created! Waiting for final payload…
            </div>
          ) : (
            <button
              onClick={handleCreateCourse}
              disabled={isStreaming || creating}
              style={{ width: '100%', background: isStreaming || creating ? '#e5e7eb' : '#111827', color: isStreaming || creating ? '#9ca3af' : '#fff', border: 'none', borderRadius: 10, padding: '11px 0', fontSize: 14, fontWeight: 600, cursor: isStreaming || creating ? 'default' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 0.15s', marginBottom: 10 }}>
              {creating ? <><Spinner color='#fff' /> Building structure…</> : 'Create this course'}
            </button>
          )}

          {/* Divider */}
          {coursePayload && <div style={{ borderTop: '1px dashed #e5e7eb', margin: '4px 0 14px' }} />}

          {/* Learnyst publish button */}
          {coursePayload && (
            courseCreated ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#16a34a', fontSize: 13, fontWeight: 600 }}>
                <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>
                Published to Learnyst
              </div>
            ) : (
              <div>
                <button
                  onClick={handleLearnystCreate}
                  disabled={learnystLoading}
                  style={{ width: '100%', background: learnystLoading ? '#e5e7eb' : '#16a34a', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 0', fontSize: 14, fontWeight: 600, cursor: learnystLoading ? 'default' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 0.15s' }}>
                  {learnystLoading ? <><Spinner color='#fff' /> Publishing…</> : '🚀 Publish to Learnyst'}
                </button>
                {learnystError && <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>{learnystError}</div>}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Chat message bubble indicator for course card ────────────────────────────
const CourseCardPill: React.FC<{ card: CourseCardData; onClick: () => void }> = ({ card, onClick }) => (
  <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit', marginTop: 8, textAlign: 'left' }}>
    <span style={{ fontSize: 18 }}>🎓</span>
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#15803d' }}>{card.title}</div>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{card.total_sections} sections · {card.total_lessons} lessons · Click to preview</div>
    </div>
    <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#16a34a' strokeWidth='2' style={{ marginLeft: 4, flexShrink: 0 }}><polyline points='9 18 15 12 9 6'/></svg>
  </button>
);

// ─── Assistant bubble ─────────────────────────────────────────────────────────
const AssistantBubble: React.FC<{
  msg: Message;
  onShowPreview: (card: CourseCardData) => void;
}> = ({ msg, onShowPreview }) => {
  const html = useMemo(() => renderMarkdown(msg.content), [msg.content]);
  const showThinking = !msg.courseCard && !msg.content && !msg.done;
  const toolsDoneNoText = msg.toolEvents.length > 0 && !msg.content && !msg.done;
  return (
    <div style={{ maxWidth: '100%' }}>
      <ToolFeed events={msg.toolEvents} done={msg.done} />
      {msg.error ? (
        <div style={{ fontSize: 14, color: '#dc2626', whiteSpace: 'pre-wrap', marginTop: 6 }}>{msg.content}</div>
      ) : msg.content ? (
        <div style={{ fontSize: 14, color: '#111827', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{ __html: html }} />
      ) : showThinking || toolsDoneNoText ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0' }}>
          <style>{`@keyframes aui-bounce { 0%,80%,100%{transform:scale(0.6);opacity:0.4} 40%{transform:scale(1);opacity:1} }`}</style>
          {[0, 160, 320].map(delay => (
            <span key={delay} style={{ width: 7, height: 7, borderRadius: '50%', background: '#9ca3af', display: 'inline-block', animation: `aui-bounce 1.2s ease-in-out ${delay}ms infinite` }} />
          ))}
          <span style={{ color: '#9ca3af', fontSize: 13, marginLeft: 2 }}>{toolsDoneNoText ? 'Writing response…' : 'Thinking…'}</span>
        </div>
      ) : null}
      {msg.courseCard && <CourseCardPill card={msg.courseCard} onClick={() => onShowPreview(msg.courseCard!)} />}
      {msg.coursePayload && msg.done && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#6b7280' }}>
          <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='#16a34a' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>
          Course payload ready — use the Preview panel to publish
        </div>
      )}
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────
const ChatAssistantPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardFields, setWizardFields] = useState<WizardQuestion[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pageContext, setPageContext] = useState<PageResource[] | null>(null);

  // Preview panel state
  const [previewCard, setPreviewCard] = useState<CourseCardData | null>(null);
  const [previewMsgId, setPreviewMsgId] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Animate panel in/out
  const showPreview = useCallback((card: CourseCardData, msgId: string) => {
    setPreviewCard(card);
    setPreviewMsgId(msgId);
    setPanelMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setPanelVisible(true)));
  }, []);

  const hidePreview = useCallback(() => {
    setPanelVisible(false);
    setTimeout(() => { setPanelMounted(false); setPreviewCard(null); setPreviewMsgId(null); }, 350);
  }, []);

  const updateMsg = useCallback((id: string, updater: (m: Message) => Partial<Message>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updater(m) } : m));
  }, []);

  const streamChat = useCallback((text: string, assistantId: string, signal: AbortSignal, currentSessionId: string | null, messageId: string, ctx: Record<string, any> | null) => {
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = sseClient.subscribe(
        {
          query: `subscription AdminAssistantChat($message: String!, $messageId: String!, $sessionId: String, $resources: [PageResource!]) {
            adminAssistantChat(message: $message, messageId: $messageId, sessionId: $sessionId, resources: $resources) {
              type text intent confidence sessionId message done workflowId workflowType status label workflows tool toolId toolDisplayName input result preview clarificationFields
            }
          }`,
          variables: { message: text, messageId, sessionId: currentSessionId, ...(ctx ? { resources: ctx } : {}) },
        },
        {
          next: ({ data }: any) => {
            const event = data?.adminAssistantChat;
            if (!event) return;
            const { type, text: txt, sessionId: evtSessionId, message: msgPayload, done: evtDone, preview: previewData, tool: toolName, toolId, toolDisplayName, input: toolInput, result: toolResult, clarificationFields: evtClarificationFields } = event;
            if (evtDone) {
              updateMsg(assistantId, () => ({ done: true }));
            } else if (type === 'text_chunk' && txt) {
              updateMsg(assistantId, m => ({ content: m.content + txt }));
            } else if (type === 'session' && evtSessionId) {
              setSessionId(evtSessionId);
            } else if (type === 'error') {
              updateMsg(assistantId, () => ({ content: msgPayload ?? 'Something went wrong.', error: true, done: true }));
            } else if (type === 'done') {
              updateMsg(assistantId, () => ({ done: true }));
            } else if (type === 'preview' && previewData) {
              const d = previewData.data ?? previewData;
              const sections = d.sections ?? [];
              const totalLessons = sections.reduce((sum: number, s: any) => sum + (s.lessons?.length ?? 0), 0);
              const card: CourseCardData = {
                title: d.title ?? '',
                description: d.description ?? '',
                subject: d.subject ?? '',
                difficulty: d.difficulty ?? '',
                target_audience: d.target_audience ?? '',
                suggested_price: d.price ?? d.suggested_price ?? 0,
                currency: d.currency ?? 'INR',
                thumbnail_query: d.thumbnail_query ?? d.title ?? '',
                thumbnail: d.thumbnail ?? undefined,
                thumbnailMime: d.thumbnailMime ?? 'image/png',
                thumbnailLoading: d.thumbnailLoading ?? false,
                total_sections: sections.length,
                total_lessons: totalLessons,
              };
              updateMsg(assistantId, () => ({ courseCard: card }));
              showPreview(card, assistantId);
            } else if (type === 'tool_start' && toolName) {
              updateMsg(assistantId, m => ({ toolEvents: [...m.toolEvents, { type: 'tool_start' as const, tool_call_id: toolId ?? toolName, tool_name: toolName, display_name: toolDisplayName ?? toolName, arguments: toolInput }] }));
            } else if ((type === 'tool_complete' || type === 'tool_result') && toolName) {
              updateMsg(assistantId, m => ({ toolEvents: [...m.toolEvents, { type: 'tool_result' as const, tool_call_id: toolId ?? toolName, tool_name: toolName, success: !toolResult?.error, summary: toolResult?.error ?? undefined }] }));
            } else if (type === 'clarification' && evtClarificationFields?.length > 0) {
              setWizardFields(evtClarificationFields as WizardQuestion[]);
              setWizardOpen(true);
            }
          },
          error: (err: any) => {
            updateMsg(assistantId, () => ({ content: err?.message ?? 'SSE error', error: true, done: true }));
            reject(err);
          },
          complete: () => {
            updateMsg(assistantId, () => ({ done: true }));
            resolve();
          },
        }
      );

      signal.addEventListener('abort', () => { unsubscribe(); resolve(); });
    });
  }, [updateMsg, showPreview]);

  const onCreateCourse = useCallback(async (card: CourseCardData, price: number) => {
    const currency = card.currency === 'INR' ? '₹' : card.currency;
    const text = `Create this course: "${card.title}" with price ${currency}${price}`;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: userId, role: 'user', content: text, toolEvents: [], done: true },
      { id: assistantId, role: 'assistant', content: '', toolEvents: [], done: false },
    ]);
    setIsStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamChat(text, assistantId, ctrl.signal, sessionId, userId, pageContext);
    } catch (err: any) {
      if (err?.name !== 'AbortError') updateMsg(assistantId, () => ({ content: String(err?.message ?? 'Request failed'), error: true, done: true }));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [streamChat, updateMsg, sessionId, pageContext]);

  const onCourseCreated = useCallback(() => {
    if (previewMsgId) updateMsg(previewMsgId, () => ({ courseCreated: true }));
  }, [previewMsgId, updateMsg]);

  const sendText = useCallback(async (text: string) => {
    if (!text || isStreaming) return;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev,
      { id: userId, role: 'user', content: text, toolEvents: [], done: true },
      { id: assistantId, role: 'assistant', content: '', toolEvents: [], done: false },
    ]);
    setIsStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamChat(text, assistantId, ctrl.signal, sessionId, userId, pageContext);
    } catch (err: any) {
      if (err?.name !== 'AbortError') updateMsg(assistantId, () => ({ content: String(err?.message ?? 'Request failed'), error: true, done: true }));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, streamChat, updateMsg, sessionId, pageContext]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendText(text);
  }, [input, sendText]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  const stop = () => { abortRef.current?.abort(); setIsStreaming(false); };
  const clearChat = () => { if (!isStreaming) { setMessages([]); setSessionId(null); hidePreview(); } };

  // Get payload/created state for the preview panel
  const previewMsg = messages.find(m => m.id === previewMsgId);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'DM Sans, sans-serif', background: '#fff', overflow: 'hidden' }}>

      {/* ── Chat pane ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: panelMounted ? '1px solid #e5e7eb' : 'none', position: 'relative' }}>
        {/* Header */}
        <div style={{ borderBottom: '1px solid #e5e7eb', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>AI Assistant</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {AGENT_API}
              {sessionId && <span style={{ marginLeft: 8, color: '#16a34a' }}>● {sessionId.slice(0, 8)}…</span>}
            </div>
          </div>
          <button onClick={clearChat} disabled={isStreaming}
            style={{ fontSize: 12, color: '#6b7280', background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
            Clear
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', marginTop: 80, color: '#9ca3af' }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#111827', marginBottom: 6 }}>Hello there!</div>
              <div style={{ fontSize: 15 }}>Send a message to test your API</div>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} style={{ maxWidth: 680, margin: '0 auto', padding: '10px 20px', display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {msg.role === 'user' ? (
                <div style={{ background: '#f3f4f6', borderRadius: 16, padding: '12px 18px', maxWidth: '80%', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {msg.content}
                </div>
              ) : (
                <AssistantBubble
                  msg={msg}
                  onShowPreview={(card) => showPreview(card, msg.id)}
                />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Page context switcher */}
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, background: '#fafafa' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>Page</span>
          {PAGE_PRESETS.map(preset => {
            const active = JSON.stringify(pageContext) === JSON.stringify(preset.value);
            return (
              <button
                key={preset.label}
                onClick={() => setPageContext(preset.value)}
                style={{
                  fontSize: 12, padding: '3px 10px', borderRadius: 20, border: '1px solid',
                  borderColor: active ? '#16a34a' : '#e5e7eb',
                  background: active ? '#f0fdf4' : '#fff',
                  color: active ? '#15803d' : '#6b7280',
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                }}
              >
                {preset.label}
              </button>
            );
          })}
          {pageContext && (
            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {JSON.stringify(pageContext)}
            </span>
          )}
        </div>

        {/* Composer */}
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 20px', flexShrink: 0 }}>
          <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 8, border: '1px solid #e5e7eb', borderRadius: 16, padding: '8px 8px 8px 16px', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <textarea ref={textareaRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKeyDown}
              placeholder='Send a message... (Enter to send, Shift+Enter for newline)' rows={1} disabled={isStreaming}
              style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', fontSize: 14, lineHeight: 1.5, maxHeight: 120, overflowY: 'auto', background: 'transparent', fontFamily: 'inherit', color: '#111827' }}
              onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }} />
            {isStreaming ? (
              <button onClick={stop} title='Stop' style={{ width: 32, height: 32, borderRadius: '50%', background: '#111827', color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ width: 10, height: 10, background: '#fff', borderRadius: 2, display: 'block' }} />
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()} title='Send' style={{ width: 32, height: 32, borderRadius: '50%', background: input.trim() ? '#16a34a' : '#e5e7eb', color: '#fff', border: 'none', cursor: input.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.15s' }}>
                <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'><line x1='12' y1='19' x2='12' y2='5'/><polyline points='5 12 12 5 19 12'/></svg>
              </button>
            )}
          </div>
        </div>

        {/* Course Wizard — floats over the composer, anchored to the bottom */}
        {wizardOpen && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20, padding: '0 20px 16px' }}>
            <div style={{ maxWidth: 680, margin: '0 auto' }}>
              <CourseWizard
                fields={wizardFields}
                onComplete={(msg) => { setWizardOpen(false); setWizardFields([]); sendText(msg); }}
                onClose={() => { setWizardOpen(false); setWizardFields([]); }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Preview pane (slide in from right) ── */}
      <div style={{
        width: panelMounted ? 360 : 0,
        flexShrink: 0,
        overflow: 'hidden',
        transition: 'width 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        background: '#fafafa',
      }}>
        <div style={{
          width: 360,
          height: '100%',
          opacity: panelVisible ? 1 : 0,
          transform: panelVisible ? 'translateX(0)' : 'translateX(24px)',
          transition: 'opacity 0.3s ease, transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        }}>
          {panelMounted && previewCard && (
            <PreviewPanel
              card={previewCard}
              coursePayload={previewMsg?.coursePayload}
              courseCreated={previewMsg?.courseCreated}
              isStreaming={isStreaming}
              onCreateCourse={onCreateCourse}
              onCourseCreated={onCourseCreated}
              onClose={hidePreview}
            />
          )}
        </div>
      </div>

    </div>
  );
};

export default ChatAssistantPage;
