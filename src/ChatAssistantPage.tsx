import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { createClient } from 'graphql-sse';

// ─── Markdown renderer ────────────────────────────────────────────────────────
function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0"/>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;margin:14px 0 2px">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:700;margin:12px 0 2px;color:#111827">$1</h2>')
    .replace(/^### (.+)$/gm, (_, title) => {
      // If emoji is at the start (LLM mistake), move it to the end
      const leadingEmoji = title.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u);
      const normalized = leadingEmoji
        ? title.replace(leadingEmoji[0], '').trimStart() + ' ' + leadingEmoji[1]
        : title;
      return `<h3 style="font-size:20px;font-weight:700;margin:20px 0 6px;color:#111827;letter-spacing:-0.3px">${normalized}</h3>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px;font-family:monospace">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#16a34a;text-decoration:underline">$1</a>');
  // Tables: convert markdown table blocks to <table> HTML
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(l => l.trim());
    const isHeaderSep = (l: string) => /^\|[\s\-:|]+\|/.test(l);
    let tableHtml = '<div style="overflow-x:auto;margin:12px 0"><table style="width:100%;border-collapse:collapse;font-size:13px">';
    let inBody = false;
    for (const row of rows) {
      if (isHeaderSep(row)) { inBody = true; continue; }
      const cells = row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const tag = !inBody ? 'th' : 'td';
      const cellStyle = !inBody
        ? 'padding:8px 12px;text-align:left;background:#f9fafb;font-weight:600;border-bottom:2px solid #e5e7eb;border-right:1px solid #e5e7eb;white-space:nowrap'
        : 'padding:8px 12px;border-bottom:1px solid #f3f4f6;border-right:1px solid #f3f4f6;color:#374151';
      tableHtml += `<tr>${cells.map(c => `<${tag} style="${cellStyle}">${c}</${tag}>`).join('')}</tr>`;
    }
    tableHtml += '</table></div>';
    return tableHtml;
  });
  html = html.replace(/((?:^[ \t]*[*\-•] .+\n?)+)/gm, (block) => {
    const items = block.split('\n').filter(l => l.trim())
      .map(l => `<li style="margin:10px 0;line-height:1.7">${l.replace(/^[ \t]*[*\-•] /, '')}</li>`).join('');
    return `<ul style="margin:16px 0 16px 20px;padding:0;list-style:disc">${items}</ul>`;
  });
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const firstNum = parseInt(block.match(/^[ \t]*(\d+)\./m)?.[1] ?? '1', 10);
    const items = block.split('\n').filter(l => l.trim())
      .map(l => `<li style="margin:10px 0;line-height:1.7">${l.replace(/^[ \t]*\d+\. /, '')}</li>`).join('');
    return `<ol start="${firstNum}" style="margin:16px 0 16px 20px;padding:0">${items}</ol>`;
  });
  const TIP_CARD = (content: string) =>
    `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid #16a34a;border-radius:8px;padding:10px 14px;margin:14px 0;display:flex;gap:10px;align-items:flex-start"><span style="font-size:16px;flex-shrink:0;margin-top:1px">💡</span><div style="line-height:1.7;color:#166534">${content}</div></div>`;
  // Tip blockquotes with > prefix: > 💡 **Tip:** ...
  html = html.replace(/^&gt; 💡 (.+)$/gm, (_, content) => TIP_CARD(content));
  // Tip without > prefix: 💡 **Tip:** ... (LLM sometimes omits the >)
  html = html.replace(/^💡 (.+)$/gm, (_, content) => TIP_CARD(content));
  // Regular blockquotes
  html = html.replace(/^&gt; (.+)$/gm, (_, content) =>
    `<div style="border-left:3px solid #e5e7eb;padding:6px 12px;margin:10px 0;color:#6b7280;font-style:italic">${content}</div>`
  );
  html = html.split(/\n{2,}/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|hr|pre|div)/.test(t)) return t;
    return `<p style="margin:10px 0;line-height:1.8">${t.replace(/\n/g, ' ')}</p>`;
  }).join('\n');
  return html;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface CourseCardData {
  title: string;
  description: string;
  subject: string;
  difficulty: string;
  target_audience: string;
  suggested_price: number;
  currency: string;
  thumbnail_query: string;
  thumbnail?: string;         // public GCS URL of the AI-generated thumbnail (when available)
  thumbnailLoading?: boolean; // true while thumbnail is still generating
  total_sections: number;
  total_lessons: number;
}

interface Milestone {
  label: string;
  status: 'pending' | 'active' | 'done';
}

interface Action {
  id: string;
  label: string;
  icon: string;
  description: string;
  example: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  courseCard?: CourseCardData;
  courseCardLive?: boolean;
  coursePayload?: any;
  courseCreated?: boolean;
  progress?: { current: number; total: number; label: string };
  milestones?: Milestone[];
  actions?: Action[];
  done: boolean;
  error?: boolean;
}
const isLocalHost = false
const API_BASE_URL = isLocalHost ? 'http://localhost:3001' : 'https://ai-api-dev.learnyst.com';


// ─── API config ───────────────────────────────────────────────────────────────
const AGENT_API = `${API_BASE_URL}/admin-ai/stream`;
const ADMIN_GQL = `${API_BASE_URL}/admin-ai`;
const LEARNYST_API = `${API_BASE_URL}/api/courses`;
const AUTH_TOKEN = `Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjc5MzA0MTcsInNpZCI6MTUyNDMyLCJleHAiOjE3ODA2NTE3NTUsInR5cCI6NCwibG9rIjoiMDAwMCIsImlzQWRtaW4iOnRydWUsInRvayI6Imx6VGZ0REtCbFFYczg1X2JJQjdiN0EiLCJ0aW1lIjoxNzgwMzkyNTU1fQ.GJKh35Ep_GzeGQ1U3z5yCYxJZJ___P1j2jwJJd2lecc`;
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

// ─── Thinking indicator ───────────────────────────────────────────────────────
const THINKING_TEXTS = [
  'Analyzing your request',
  'Gathering information',
  'Crafting a response',
  'Thinking it through',
  'Searching for answers',
  'Putting it together',
];

const ThinkingIndicator: React.FC = () => {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex(i => (i + 1) % THINKING_TEXTS.length);
        setVisible(true);
      }, 300);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <style>{`
        @keyframes aui-spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes aui-thinking-fade { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
      {/* Spinner ring with sparkle */}
      <div style={{ position: 'relative', width: 20, height: 20, flexShrink: 0 }}>
        <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='#7c3aed' strokeWidth='2'
          style={{ animation: 'aui-spin 1.4s linear infinite', position: 'absolute', top: 0, left: 0, opacity: 0.4 }}>
          <circle cx='12' cy='12' r='10'/>
        </svg>
        <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='#7c3aed' strokeWidth='2.5'
          style={{ animation: 'aui-spin 1.4s linear infinite', position: 'absolute', top: 0, left: 0 }}>
          <path d='M21 12a9 9 0 11-6.219-8.56'/>
        </svg>
        {/* Sparkle */}
        <svg width='8' height='8' viewBox='0 0 24 24' fill='#7c3aed'
          style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', animation: 'aui-thinking-fade 1.4s ease-in-out infinite' }}>
          <path d='M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z'/>
        </svg>
      </div>
      <span style={{
        fontSize: 14,
        color: '#6b7280',
        transition: 'opacity 0.3s ease',
        opacity: visible ? 1 : 0,
      }}>
        {THINKING_TEXTS[index]}…
      </span>
    </div>
  );
};

// ─── Course creation wizard ───────────────────────────────────────────────────
interface WizardOption { label: string; primary?: boolean; }
interface WizardQuestion {
  field: string;
  type?: 'text' | 'select' | 'multi-select' | 'number';
  question: string;
  options: WizardOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
  unit?: string;
}



const CourseWizard: React.FC<{ onComplete: (msg: string) => void; onClose: () => void; fields: WizardQuestion[] }> = ({ onComplete, onClose, fields }) => {
  const questions = fields;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, { question: string; answer: string }>>({});
  const [custom, setCustom] = useState('');
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const q = questions[step];
  const isLast = step === questions.length - 1;
  const isMultiSelect = q?.type === 'multi-select';

  const handleSelect = (value: string) => {
    const next = { ...answers, [q.field]: { question: q.question, answer: value } };
    setCustom('');
    setMultiSelected(new Set());
    if (isLast) {
      // Build prompt as "Question: Answer" pairs
      const parts = Object.values(next).map(({ question, answer }) => `${question}: ${answer}`);
      onComplete(parts.join('. ') + '.');
    }
    else { setAnswers(next); setStep(s => s + 1); }
  };

  const handleMultiToggle = (opt: string) => {
    setMultiSelected(prev => {
      const next = new Set(prev);
      if (next.has(opt)) next.delete(opt); else next.add(opt);
      return next;
    });
  };

  const handleMultiConfirm = () => {
    if (multiSelected.size > 0) handleSelect(Array.from(multiSelected).join(', '));
  };

  const handleCustomSubmit = () => { if (custom.trim()) handleSelect(custom.trim()); };

  if (!q) return null;

  return (
    <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', overflow: 'hidden', border: '1px solid #e5e7eb' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 16px' }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>{q.question}</span>
            {q.unit && <span style={{ fontSize: 13, color: '#9ca3af', marginLeft: 6 }}>({q.unit})</span>}
            {isMultiSelect && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>Select one or more</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#9ca3af' }}>
              <button onClick={() => { if (step > 0) { setStep(s => s - 1); setMultiSelected(new Set()); setCustom(''); } }} disabled={step === 0} style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: step > 0 ? 'pointer' : 'default', color: step > 0 ? '#6b7280' : '#d1d5db', display: 'flex', alignItems: 'center' }}>
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

        {/* Options — single select or multi-select */}
        {q.options.length > 0 && (
          <div style={{ padding: '0 16px' }}>
            {isMultiSelect ? (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 0 8px' }}>
                  {q.options.map(opt => {
                    const selected = multiSelected.has(opt.label);
                    return (
                      <button key={opt.label} onClick={() => handleMultiToggle(opt.label)} style={{
                        padding: '8px 14px', borderRadius: 20, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', transition: 'all 0.15s',
                        background: selected ? '#f0fdf4' : '#fff', border: `1px solid ${selected ? '#16a34a' : '#e5e7eb'}`,
                        color: selected ? '#15803d' : '#374151', fontWeight: selected ? 600 : 400,
                      }}>{selected ? '✓ ' : ''}{opt.label}</button>
                    );
                  })}
                </div>
                <button onClick={handleMultiConfirm} disabled={multiSelected.size === 0} style={{
                  width: '100%', padding: '10px', marginBottom: 8, borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: multiSelected.size > 0 ? 'pointer' : 'default',
                  background: multiSelected.size > 0 ? '#16a34a' : '#e5e7eb', color: '#fff', transition: 'background 0.15s',
                }}>Confirm ({multiSelected.size} selected)</button>
              </>
            ) : (
              q.options.map((opt, i) => {
                return (
                  <button key={opt.label} onClick={() => handleSelect(opt.label)} style={{
                    display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '13px 12px', marginBottom: 4,
                    background: opt.primary ? '#4f46e5' : 'none', border: opt.primary ? '1px solid #4f46e5' : 'none', borderRadius: 10,
                    cursor: 'pointer', textAlign: 'left', fontSize: 14, color: opt.primary ? '#fff' : '#111827', fontWeight: opt.primary ? 600 : 400, transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { if (!opt.primary) e.currentTarget.style.background = '#f9fafb'; }}
                    onMouseLeave={e => { if (!opt.primary) e.currentTarget.style.background = 'none'; }}>
                    {!opt.primary && <span style={{ width: 26, height: 26, borderRadius: 8, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>{i + 1}</span>}
                    {opt.label}
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* Custom / text / number input */}
        {(q.allowCustom || q.type === 'text' || q.type === 'number') && (
          <div style={{ margin: '8px 16px 0', display: 'flex', alignItems: 'center', gap: 8, background: '#f9fafb', borderRadius: 10, padding: '10px 12px', border: '1px solid #f3f4f6' }}>
            <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#9ca3af' strokeWidth='2'><path d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'/><path d='M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'/></svg>
            <input value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
              type={q.type === 'number' ? 'number' : 'text'}
              placeholder={q.customPlaceholder ?? 'Type your answer…'}
              style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: '#111827', fontFamily: 'inherit' }} />
            {q.unit && <span style={{ fontSize: 13, color: '#9ca3af', flexShrink: 0 }}>{q.unit}</span>}
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

// ─── Milestone tracker ────────────────────────────────────────────────────────
const MilestoneTracker: React.FC<{ milestones: Milestone[] }> = ({ milestones }) => {
  const completedCount = milestones.filter(m => m.status === 'done').length;
  const allDone = milestones.every(m => m.status === 'done');
  return (
    <div style={{ marginBottom: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        {allDone
          ? <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='#7c3aed' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>
          : <Spinner color='#7c3aed' size={14} />}
        <span style={{ fontSize: 12, color: '#7c3aed', fontWeight: 600 }}>
          {completedCount} action{completedCount !== 1 ? 's' : ''} completed
        </span>
      </div>
      {/* Steps */}
      <div style={{ position: 'relative', paddingLeft: 22 }}>
        <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 1, background: '#e5e7eb' }} />
        {milestones.map((m, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: i < milestones.length - 1 ? 12 : 0 }}>
            <div style={{ position: 'absolute', left: 0, zIndex: 1 }}>
              {m.status === 'done' && (
                <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#7c3aed', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='#fff' strokeWidth='3.5'><polyline points='20 6 9 17 4 12'/></svg>
                </div>
              )}
              {m.status === 'active' && <Spinner color='#7c3aed' size={16} />}
              {m.status === 'pending' && (
                <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px dashed #d1d5db', background: '#fff' }} />
              )}
            </div>
            <span style={{ fontSize: 13, color: m.status === 'done' ? '#111827' : m.status === 'active' ? '#374151' : '#9ca3af', fontWeight: m.status !== 'pending' ? 500 : 400 }}>
              {m.label}
            </span>
          </div>
        ))}
      </div>
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
    ? card.thumbnail
    : card.thumbnail_query
      ? `https://source.unsplash.com/640x300/?${encodeURIComponent(card.thumbnail_query)}`
      : PLACEHOLDER;
  const thumbLoading = card.thumbnailLoading === true;
  const currency = card.currency === 'INR' ? '₹' : card.currency;

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: '4px 6px', display: 'flex', alignItems: 'center', borderRadius: 6 }}>
          <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'><polyline points='15 18 9 12 15 6'/></svg>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Save button */}
          {!isStreaming && createStatus !== 'success' && (
            <button onClick={handleCreateCourse} disabled={creating}
              style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 8, padding: '5px 14px', fontSize: 13, fontWeight: 600, color: '#111827', cursor: creating ? 'default' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
              {creating ? <><Spinner size={11} color='#6b7280' />Saving…</> : 'Save'}
            </button>
          )}
          {createStatus === 'success' && (
            <span style={{ fontSize: 13, fontWeight: 600, color: '#16a34a', display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>Saved
            </span>
          )}
          {/* Expand icon */}
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4, display: 'flex' }}>
            <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><polyline points='15 3 21 3 21 9'/><polyline points='9 21 3 21 3 15'/><line x1='21' y1='3' x2='14' y2='10'/><line x1='3' y1='21' x2='10' y2='14'/></svg>
          </button>
          {/* Close */}
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4, display: 'flex' }}>
            <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><line x1='18' y1='6' x2='6' y2='18'/><line x1='6' y1='6' x2='18' y2='18'/></svg>
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px' }}>
        {/* Thumbnail */}
        <div style={{ borderRadius: 16, overflow: 'hidden', background: '#f3f4f6', position: 'relative', marginBottom: 20 }}>
          <img src={thumbLoading ? PLACEHOLDER : thumbSrc} alt={card.title}
            style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block', filter: thumbLoading ? 'blur(8px)' : 'none', transform: thumbLoading ? 'scale(1.05)' : 'none', transition: 'filter 0.4s, transform 0.4s' }}
            onError={e => { (e.target as HTMLImageElement).src = PLACEHOLDER; }} />
          {thumbLoading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.3)' }}>
              <Spinner color='#fff' size={20} />
              <span style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>Generating thumbnail…</span>
            </div>
          )}
        </div>

        {/* Title */}
        <div style={{ fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: 1.3, marginBottom: 8 }}>{card.title}</div>

        {/* Lessons count */}
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>{card.total_lessons} Lessons</div>

        {/* Price + duration row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#111827' }}>
            {price === 0 ? 'Free' : `${currency}${price.toLocaleString()}`}
          </div>
          <div style={{ fontSize: 13, color: '#9ca3af' }}>365 Days</div>
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px solid #f3f4f6', marginBottom: 16 }} />

        {/* Description */}
        {card.description && (
          <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.7, marginBottom: 20 }}>{card.description}</div>
        )}

        {/* Learnyst publish button */}
        {coursePayload && (
          courseCreated ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#16a34a', fontSize: 13, fontWeight: 600, marginTop: 8 }}>
              <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>
              Published to Learnyst
            </div>
          ) : (
            <div>
              <button onClick={handleLearnystCreate} disabled={learnystLoading}
                style={{ width: '100%', background: learnystLoading ? '#e5e7eb' : '#111827', color: learnystLoading ? '#9ca3af' : '#fff', border: 'none', borderRadius: 10, padding: '12px 0', fontSize: 14, fontWeight: 600, cursor: learnystLoading ? 'default' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 0.15s' }}>
                {learnystLoading ? <><Spinner color='#9ca3af' /> Publishing…</> : 'Add to courses'}
              </button>
              {learnystError && <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>{learnystError}</div>}
            </div>
          )
        )}
      </div>
    </div>
  );
};

// ─── Chat message bubble indicator for course card ────────────────────────────
const CourseCardPill: React.FC<{ card: CourseCardData; onClick: () => void; live?: boolean }> = ({ card, onClick, live }) => (
  <div style={{ marginTop: 12 }}>
    {live && (
      <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>Course created</div>
    )}
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 4 }}>{card.title}</div>
      <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 14 }}>
        Course • {card.total_sections} Sections • {card.total_lessons} Lessons
      </div>
      <button onClick={onClick}
        style={{ background: '#111827', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
        {live ? 'View course' : 'Add to courses'}
      </button>
    </div>
  </div>
);

// ─── Action cards ─────────────────────────────────────────────────────────────
const ActionCards: React.FC<{ actions: Action[]; onActionClick: (example: string) => void }> = ({ actions, onActionClick }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
    {actions.map(action => (
      <button
        key={action.id}
        onClick={() => onActionClick(action.example)}
        title={action.description}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer', fontSize: 13, color: '#374151', fontFamily: 'inherit', transition: 'border-color 0.15s, background 0.15s' }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#6366f1'; (e.currentTarget as HTMLButtonElement).style.background = '#f5f3ff'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#e5e7eb'; (e.currentTarget as HTMLButtonElement).style.background = '#fff'; }}
      >
        <span style={{ fontSize: 15 }}>{action.icon}</span>
        <span style={{ fontWeight: 500 }}>{action.label}</span>
      </button>
    ))}
  </div>
);

// ─── Assistant bubble ─────────────────────────────────────────────────────────
const AssistantBubble: React.FC<{
  msg: Message;
  onShowPreview: (card: CourseCardData) => void;
  onActionClick: (example: string) => void;
}> = ({ msg, onShowPreview, onActionClick }) => {
  const html = useMemo(() => renderMarkdown(msg.content), [msg.content]);
  const showThinking = !msg.courseCard && !msg.content && !msg.done;
  return (
    <div style={{ maxWidth: '100%' }}>
      {msg.milestones && msg.milestones.length > 0 && <MilestoneTracker milestones={msg.milestones} />}
      {msg.error ? (
        <div style={{ fontSize: 14, color: '#dc2626', whiteSpace: 'pre-wrap', marginTop: 6 }}>{msg.content}</div>
      ) : msg.content ? (
        <div style={{ fontSize: 14, color: '#111827', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{ __html: html }} />
      ) : showThinking ? (
        <ThinkingIndicator />
      ) : null}
      {msg.progress && !msg.done && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{msg.progress.label}</span>
            <span style={{ fontSize: 11, color: '#6b7280' }}>{msg.progress.current}/{msg.progress.total}</span>
          </div>
          <div style={{ height: 6, background: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, #6366f1, #8b5cf6)', width: `${Math.round((msg.progress.current / msg.progress.total) * 100)}%`, transition: 'width 0.3s ease' }} />
          </div>
        </div>
      )}
      {msg.courseCard && <CourseCardPill card={msg.courseCard} live={msg.courseCardLive} onClick={() => onShowPreview(msg.courseCard!)} />}
      {msg.actions && msg.actions.length > 0 && <ActionCards actions={msg.actions} onActionClick={onActionClick} />}
      {msg.coursePayload && msg.done && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#6b7280' }}>
          <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='#16a34a' strokeWidth='2.5'><polyline points='20 6 9 17 4 12'/></svg>
          Course payload ready — use the Preview panel to publish
        </div>
      )}
    </div>
  );
};

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

async function gqlQuery<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const res = await fetch(ADMIN_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message ?? 'GraphQL error');
  return json.data;
}

interface SessionItem { id: string; title: string | null; createdAt: string; isExpired: boolean }

async function fetchSessions(): Promise<SessionItem[]> {
  const data = await gqlQuery<{ aiSessions: { items: SessionItem[] } }>(
    `query { aiSessions(limit: 30) { items { id title createdAt isExpired } } }`
  );
  return data.aiSessions.items;
}

interface RawSessionMessage {
  id: string; role: string; content: string; workflowId: string | null;
  uiMetadata: { actions?: Action[]; preview?: any; clarification?: any[] } | null;
  createdAt: string;
}

async function fetchSessionMessages(sessionId: string): Promise<RawSessionMessage[]> {
  const data = await gqlQuery<{ aiSessionMessages: { items: RawSessionMessage[] } }>(
    `query ($sid: ID!) { aiSessionMessages(sessionId: $sid, limit: 50) { items { id role content workflowId uiMetadata createdAt } } }`,
    { sid: sessionId },
  );
  return data.aiSessionMessages.items;
}

// ─── Session sidebar ─────────────────────────────────────────────────────────

const SessionSidebar: React.FC<{
  sessions: SessionItem[];
  activeSessionId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRefresh: () => void;
}> = ({ sessions, activeSessionId, loading, onSelect, onNewChat, onRefresh }) => (
  <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', background: '#fafafa', height: '100%' }}>
    <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #e5e7eb' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Sessions</span>
      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={onRefresh} title="Refresh" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, borderRadius: 4 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21.5 2v6h-6M2.5 22v-6h6"/><path d="M2.5 11.5a10 10 0 0 1 18.37-4.5M21.5 12.5a10 10 0 0 1-18.37 4.5"/></svg>
        </button>
        <button onClick={onNewChat} title="New chat" style={{ background: '#16a34a', border: 'none', cursor: 'pointer', color: '#fff', padding: '4px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
          + New
        </button>
      </div>
    </div>
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {loading && <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading…</div>}
      {!loading && sessions.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No sessions</div>}
      {sessions.map(s => {
        const active = s.id === activeSessionId;
        return (
          <button key={s.id} onClick={() => onSelect(s.id)} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none',
            background: active ? '#f0fdf4' : 'transparent', cursor: 'pointer', fontFamily: 'inherit',
            borderLeft: active ? '3px solid #16a34a' : '3px solid transparent',
          }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#f3f4f6'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
            <div style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.title ?? s.id.slice(0, 12) + '…'}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              {new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </div>
          </button>
        );
      })}
    </div>
  </div>
);

// ─── Page ─────────────────────────────────────────────────────────────────────

const ChatAssistantPage: React.FC = () => {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardFields, setWizardFields] = useState<WizardQuestion[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pageContext, setPageContext] = useState<PageResource[] | null>(null);

  // Session sidebar state
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);

  // Preview panel state
  const [previewCard, setPreviewCard] = useState<CourseCardData | null>(null);
  const [previewMsgId, setPreviewMsgId] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load sessions on mount
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try { setSessions(await fetchSessions()); } catch (e) { console.error('Failed to load sessions', e); }
    finally { setSessionsLoading(false); }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Load a session's message history and hydrate uiMetadata
  const loadSession = useCallback(async (sid: string) => {
    if (isStreaming) return;
    setMessagesLoading(true);
    setSessionId(sid);
    setMessages([]);
    hidePreview();
    setWizardOpen(false);
    try {
      const rawMsgs = await fetchSessionMessages(sid);
      const hydrated: Message[] = rawMsgs
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => {
          const msg: Message = { id: m.id, role: m.role as 'user' | 'assistant', content: m.content, done: true };
          // uiMetadata hydration is done separately below (only last per workflow)
          return msg;
        });

      // Hydrate uiMetadata — only from the LAST assistant message that has it
      // (older messages may have stale cards from previous turns)
      let lastUiMsg: RawSessionMessage | null = null;
      for (const m of rawMsgs) {
        if (m.role === 'assistant' && m.uiMetadata) lastUiMsg = m;
      }

      if (lastUiMsg?.uiMetadata) {
        const ui = lastUiMsg.uiMetadata;
        const idx = hydrated.findIndex(m => m.id === lastUiMsg!.id);
        if (idx >= 0) {
          if (ui.actions) hydrated[idx].actions = ui.actions;
          if (ui.preview) {
            const d = ui.preview.data ?? ui.preview;
            const sections = d.sections ?? [];
            const totalLessons = sections.reduce((sum: number, s: any) => sum + (s.lessons?.length ?? 0), 0);
            hydrated[idx].courseCard = {
              title: d.title ?? '', description: d.description ?? '', subject: d.subject ?? '',
              difficulty: d.difficulty ?? '', target_audience: d.target_audience ?? '',
              suggested_price: d.price ?? d.suggested_price ?? 0, currency: d.currency ?? 'INR',
              thumbnail_query: d.thumbnail_query ?? d.title ?? '',
              thumbnail: d.thumbnail ?? undefined, thumbnailLoading: false,
              total_sections: sections.length, total_lessons: totalLessons,
            };
          }
          if (ui.clarification) {
            setWizardFields(ui.clarification as WizardQuestion[]);
            setWizardOpen(true);
          }
        }
      }

      setMessages(hydrated);
    } catch (e) { console.error('Failed to load messages', e); }
    finally { setMessagesLoading(false); }
  }, [isStreaming]);

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
              type text intent confidence sessionId message done workflowId workflowType status label workflows preview clarificationFields current total milestones actions
            }
          }`,
          variables: { message: text, messageId, sessionId: currentSessionId, ...(ctx ? { resources: ctx } : {}) },
        },
        {
          next: ({ data }: any) => {
            const event = data?.adminAssistantChat;
            if (!event) return;
            const { type, text: txt, sessionId: evtSessionId, message: msgPayload, done: evtDone, preview: previewData, clarificationFields: evtClarificationFields, current: progressCurrent, total: progressTotal, label: progressLabel, milestones: evtMilestones, actions: evtActions } = event;
            if (evtDone) {
              updateMsg(assistantId, () => ({ done: true }));
            } else if (type === 'text_chunk' && txt) {
              updateMsg(assistantId, m => ({ content: m.content + txt }));
            } else if (type === 'session' && evtSessionId) {
              setSessionId(evtSessionId);
            } else if (type === 'error' || type === 'workflow_failed') {
              updateMsg(assistantId, () => ({ content: msgPayload ?? 'Something went wrong.', error: true, done: true }));
            } else if (type === 'done') {
              updateMsg(assistantId, () => ({ done: true }));
            } else if (type === 'preview' && previewData === null) {
              // Backend signalled to hide the preview (pause/cancel)
              updateMsg(assistantId, () => ({ courseCard: undefined }));
              hidePreview();
            } else if (type === 'preview' && previewData) {
              const d = previewData.data ?? previewData;
              if (previewData.thumbnailOnly) {
                // Patch only thumbnail fields — do not replace the full outline card
                updateMsg(assistantId, (m) => ({
                  courseCard: m.courseCard ? {
                    ...m.courseCard,
                    thumbnail: d.thumbnail ?? m.courseCard.thumbnail,
                    thumbnailLoading: d.thumbnailLoading ?? false,
                  } : m.courseCard,
                }));
                setPreviewCard(prev => prev ? { ...prev, thumbnail: d.thumbnail ?? prev.thumbnail, thumbnailLoading: d.thumbnailLoading ?? false } : prev);
              } else {
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
                thumbnailLoading: d.thumbnailLoading ?? false,
                total_sections: sections.length,
                total_lessons: totalLessons,
              };
              const isLive = previewData.status === 'live';
              updateMsg(assistantId, () => ({ courseCard: card, ...(isLive ? { courseCardLive: true } : {}) }));
              showPreview(card, assistantId);
              }
            } else if (type === 'progress' && progressTotal) {
              updateMsg(assistantId, () => ({ progress: { current: progressCurrent, total: progressTotal, label: progressLabel ?? '' } }));
            } else if (type === 'milestone' && evtMilestones?.length > 0) {
              updateMsg(assistantId, () => ({ milestones: evtMilestones as Milestone[] }));
            } else if (type === 'actions' && evtActions?.length > 0) {
              updateMsg(assistantId, () => ({ actions: evtActions as Action[] }));
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
      { id: userId, role: 'user', content: text, done: true },
      { id: assistantId, role: 'assistant', content: '', done: false },
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
    setMessages(prev => {
      // Clear actions from the last assistant message so stale cards don't persist
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].role === 'assistant') { updated[i] = { ...updated[i], actions: undefined }; break; }
      }
      return [...updated,
        { id: userId, role: 'user', content: text, done: true },
        { id: assistantId, role: 'assistant', content: '', done: false },
      ];
    });
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
  const clearChat = () => { if (!isStreaming) { setMessages([]); setSessionId(null); hidePreview(); setWizardOpen(false); } };

  // Get payload/created state for the preview panel
  const previewMsg = messages.find(m => m.id === previewMsgId);

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', fontFamily: 'DM Sans, sans-serif', background: '#fff', overflow: 'hidden' }}>

      {/* ── Session sidebar ── */}
      <SessionSidebar
        sessions={sessions}
        activeSessionId={sessionId}
        loading={sessionsLoading}
        onSelect={loadSession}
        onNewChat={clearChat}
        onRefresh={loadSessions}
      />

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => navigate('/ingest-kb')}
              style={{ fontSize: 12, color: '#15803d', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
              </svg>
              Ingest KB
            </button>
            <button onClick={clearChat} disabled={isStreaming}
              style={{ fontSize: 12, color: '#6b7280', background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
              Clear
            </button>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
          {messagesLoading && (
            <div style={{ textAlign: 'center', marginTop: 80, color: '#9ca3af' }}>
              <Spinner color="#9ca3af" size={20} />
              <div style={{ fontSize: 13, marginTop: 8 }}>Loading messages…</div>
            </div>
          )}
          {!messagesLoading && messages.length === 0 && (
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
                  onActionClick={sendText}
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
