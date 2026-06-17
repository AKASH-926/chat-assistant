import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createClient } from 'graphql-sse';

// ─── Clickable lesson-video timestamp chip ─────────────────────────────────────
// Matches `[HH:MM:SS]`, `[MM:SS]`, or comma-separated lists like
// `[HH:MM:SS, HH:MM:SS]` produced by the contentDoubt agent.
// Strict 2-digit minute:second pattern avoids false-matches on ratios like [1:5].
// The chip renders its own play icon and dispatches `learnyst:seek-video` on click.
//   Single:    [00:28:32]  →  one chip
//   Multi:     [00:27:48, 00:29:00]  →  two chips
const TIMESTAMP_TOKEN = String.raw`\d{1,2}:\d{2}(?::\d{2})?`; // MM:SS or HH:MM:SS
const TIMESTAMP_GROUP_RE = new RegExp(
  String.raw`\[(${TIMESTAMP_TOKEN}(?:\s*,\s*${TIMESTAMP_TOKEN})*)\]`,
  'g',
);
const SINGLE_TIMESTAMP_RE = new RegExp(TIMESTAMP_TOKEN, 'g');

function timestampToSeconds(ts: string): number {
  const parts = ts.split(':').map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function buildTimestampChip(ts: string, orderIndex: number): string {
  const seconds = timestampToSeconds(ts);
  // data-timestamp-order is the chip's position in the response (0-based).
  // The click handler uses it to look up msg.metadata.product_data[order].
  return `<button type="button" class="ts-chip" data-timestamp-seconds="${seconds}" data-timestamp-order="${orderIndex}" aria-label="Jump to ${ts} in the lesson video"><span class="ts-chip-icon">▶</span><span class="ts-chip-time">${ts}</span></button>`;
}

// ─── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(md: string): string {
  // No HTML escaping — LLM responses may contain raw HTML tags that should render
  // Track timestamp order across the response so each chip carries its index
  // (used to look up the matching `metadata` event payload by order on click).
  let timestampOrder = 0;
  let html = md
    // Replace timestamp tokens FIRST so the brackets don't get parsed as a markdown link.
    // Handles single `[HH:MM:SS]` and comma-separated `[HH:MM:SS, HH:MM:SS]` groups.
    .replace(TIMESTAMP_GROUP_RE, (_match, group: string) => {
      const tokens = group.match(SINGLE_TIMESTAMP_RE) ?? [];
      return tokens.map((ts) => buildTimestampChip(ts, timestampOrder++)).join(' ');
    })
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0"/>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;margin:14px 0 2px">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:700;margin:12px 0 2px;color:#111827">$1</h2>')
    .replace(/^### (.+)$/gm, (_, title) => {
      const leadingEmoji = title.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u);
      const normalized = leadingEmoji
        ? title.replace(leadingEmoji[0], '').trimStart() + ' ' + leadingEmoji[1]
        : title;
      return `<h3 style="font-size:20px;font-weight:700;margin:20px 0 6px;color:#111827;letter-spacing:-0.3px">${normalized}</h3>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:13px;font-family:monospace">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline">$1</a>');
  // Tables
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
    `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-left:4px solid #2563eb;border-radius:8px;padding:10px 14px;margin:14px 0;display:flex;gap:10px;align-items:flex-start"><span style="font-size:16px;flex-shrink:0;margin-top:1px">💡</span><div style="line-height:1.7;color:#1e40af">${content}</div></div>`;
  html = html.replace(/^> 💡 (.+)$/gm, (_, content) => TIP_CARD(content));
  html = html.replace(/^💡 (.+)$/gm, (_, content) => TIP_CARD(content));
  html = html.replace(/^> (.+)$/gm, (_, content) =>
    `<div style="border-left:3px solid #e5e7eb;padding:6px 12px;margin:10px 0;color:#6b7280;font-style:italic">${content}</div>`
  );
  html = html.split(/\n{2,}/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|hr|pre|div|p|table)/.test(t)) return t;
    return `<p style="margin:10px 0;line-height:1.8">${t.replace(/\n/g, ' ')}</p>`;
  }).join('\n');
  return html;
}

// ─── Types ─────────────────────────────────────────────────────────────────────
interface LearnerSession {
  id: string;
  title?: string;
  sessionType?: string;
  rsrcId?: number;      // courseId for lesson_chat
  rsrcLvl2Id?: number;  // lessonId for lesson_chat
  rsrcLvl3Id?: number;  // fileId for lesson_chat
  createdAt?: string;
  isExpired: boolean;
}

interface Source {
  title?: string;
  content?: string;
  lesson_title?: string;
  file_name?: string;
  [key: string]: any;
}

interface Milestone {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done';
}

interface Action {
  type: string;
  label: string;
}

// Generic JSON payload from a `metadata` SSE event. Each payload includes
// `kind` (e.g. "timestamp") plus kind-specific fields. Keep loose so the
// backend can add new kinds and fields without schema churn.
type InlineMetadata = { kind: string; [k: string]: any };

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  milestones?: Milestone[];
  actions?: Action[];
  // Inline metadata grouped by `kind` — e.g. metadata.product_data[N] is the
  // payload for the Nth timestamp chip rendered in this message.
  metadata?: Record<string, InlineMetadata[]>;
  done: boolean;
  error?: boolean;
}

// ─── API config ─────────────────────────────────────────────────────────────────
// Set to true when backend is running learner-chat-mastra-rebuild branch
const useMastra = true;
const isLocalHost = true;
const API_BASE_URL = isLocalHost ? 'http://localhost:3001' : 'https://ai-api-dev.learnyst.com';
const LEARNER_API = `${API_BASE_URL}/learn-ai/stream`;
const LEARNER_GQL = `${API_BASE_URL}/learn-ai`;

// Learner JWT — replace with a valid learner token for your dev school
const LEARNER_AUTH_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjc5MzA0MTcsInNpZCI6MTUyNDMyLCJleHAiOjIwOTQ3MDMzNDAsInR5cCI6NCwibG9rIjoiMDAwMCIsImlzQWRtaW4iOmZhbHNlLCJ0b2siOiI2OEpHczVmM21maFpSVjFNckduRzZ3IiwidGltZSI6MTc3OTA4MDE0MH0.akLSK9D-NSYnApj0ki6ZZtBNO9Yh4LyfWGxmCBCOyhk';

const sseClient = createClient({
  url: LEARNER_API,
  headers: { Authorization: LEARNER_AUTH_TOKEN },
});

async function gqlQuery(query: string, variables?: Record<string, any>) {
  const res = await fetch(LEARNER_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: LEARNER_AUTH_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const COURSE_ID = 248758;
const LESSON_ID = 4360430;
const FILE_ID = 773255;

type ScopeType = 'global' | 'course_chat' | 'lesson_chat';

function getScopeInput(scope: ScopeType) {
  switch (scope) {
    // lesson_chat: rsrcId=courseId (for RAG), rsrcLvl2Id=lessonId, rsrcLvl3Id=fileId
    case 'lesson_chat': return { sessionType: 'lesson_chat', rsrcId: COURSE_ID, rsrcLvl2Id: LESSON_ID, rsrcLvl3Id: FILE_ID };
    // course_chat: rsrcId=courseId only
    case 'course_chat': return { sessionType: 'course_chat', rsrcId: COURSE_ID, rsrcLvl2Id: null, rsrcLvl3Id: null };
    // global: school level — no resource filters
    case 'global':      return { sessionType: 'global', rsrcId: null, rsrcLvl2Id: null, rsrcLvl3Id: null };
  }
}


// ─── Source chip ────────────────────────────────────────────────────────────────
// function SourceChip({ source, index }: { source: Source; index: number }) {
//   const [expanded, setExpanded] = useState(false);
//   const label = source.title ?? source.lesson_title ?? source.file_name ?? `Source ${index + 1}`;
//   return (
//     <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 6 }}>
//       <button
//         onClick={() => setExpanded(e => !e)}
//         style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
//       >
//         <span style={{ fontWeight: 600, color: '#374151', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
//         <span style={{ color: '#9ca3af', flexShrink: 0, marginLeft: 8 }}>{expanded ? '▲' : '▼'}</span>
//       </button>
//       {expanded && (
//         <div style={{ padding: '8px 10px', fontSize: 12, color: '#6b7280', lineHeight: 1.6, background: '#fff', borderTop: '1px solid #f3f4f6' }}>
//           {source.content
//             ? <p style={{ margin: 0 }}>{source.content}</p>
//             : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(source, null, 2)}</pre>}
//         </div>
//       )}
//     </div>
//   );
// }

// ─── Milestone bar ──────────────────────────────────────────────────────────────
function MilestoneBar({ milestones }: { milestones: Milestone[] }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      {milestones.map((m) => {
        const bg = m.status === 'done' ? '#dcfce7' : m.status === 'active' ? '#eff6ff' : '#f9fafb';
        const color = m.status === 'done' ? '#16a34a' : m.status === 'active' ? '#2563eb' : '#9ca3af';
        const icon = m.status === 'done' ? '✓' : m.status === 'active' ? '⋯' : '○';
        return (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: bg, border: `1px solid ${color}22`, borderRadius: 20, padding: '3px 10px', fontSize: 11, color, fontWeight: 500 }}>
            <span>{icon}</span>
            <span>{m.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Assistant bubble ───────────────────────────────────────────────────────────
function AssistantBubble({ msg, onSuggestion, isLast, onShowSources }: { msg: Message; onSuggestion: (text: string) => void; isLast: boolean; onShowSources: (sources: Source[]) => void }) {
  // Strip [suggestion] lines from content — they come as actions from backend
  const lines = msg.content.split('\n');
  const mainLines = lines.filter((l) => !/^[-*•]?\s*\[suggestion\]/i.test(l));
  const mainContent = mainLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const html = mainContent ? renderMarkdown(mainContent) : '';
  const suggestions = (msg.actions ?? []).filter((a) => a.type === 'suggestion').map((a) => a.label);

  return (
    <div style={{ maxWidth: '85%' }}>
      {msg.milestones && msg.milestones.length > 0 && !msg.done && (
        <MilestoneBar milestones={msg.milestones} />
      )}
      {html ? (
        // eslint-disable-next-line react/no-danger
        <div
          style={{ fontSize: 14, lineHeight: 1.8, color: msg.error ? '#dc2626' : '#111827' }}
          onClick={(e) => {
            const chip = (e.target as HTMLElement).closest('[data-timestamp-seconds]') as HTMLElement | null;
            if (!chip) return;
            const seconds = Number(chip.getAttribute('data-timestamp-seconds'));
            if (!Number.isFinite(seconds)) return;
            // The Nth chip in the response corresponds to the Nth `product_data`
            // metadata event the backend emitted. The payload is opaque
            // (generic JSON, may include course_id/lesson_id/file_id and more),
            // so we merge it into the dispatched detail.
            const order = Number(chip.getAttribute('data-timestamp-order'));
            const bucket = msg.metadata?.product_data ?? [];
            const meta = Number.isFinite(order) ? bucket[order] : undefined;
            const detail = { seconds, ...(meta ?? {}) };
            window.dispatchEvent(new CustomEvent('learnyst:seek-video', { detail }));
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : !msg.done ? (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', paddingTop: 4 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#d1d5db' }} />
          ))}
        </div>
      ) : null}
      {msg.done && isLast && suggestions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          {suggestions.map((s, i) => (
            <button key={i} onClick={() => onSuggestion(s)}
              style={{ fontSize: 12, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 16, padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.5 }}>
              {s}
            </button>
          ))}
        </div>
      )}
      {msg.done && msg.sources && msg.sources.length > 0 && (
        <button onClick={() => onShowSources(msg.sources!)}
          style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6b7280', background: 'none', border: '1px solid #e5e7eb', borderRadius: 12, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
          <span>📄</span> {msg.sources.length} source{msg.sources.length > 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────────

const SESSIONS_QUERY = useMastra
  ? `query LearnerSessions($sessionType: String, $rsrcId: Int, $rsrcLvl2Id: Int, $rsrcLvl3Id: Int) {
      learnerSessions(sessionType: $sessionType, rsrcId: $rsrcId, rsrcLvl2Id: $rsrcLvl2Id, rsrcLvl3Id: $rsrcLvl3Id, limit: 20) {
        items { id title sessionType rsrcId rsrcLvl2Id rsrcLvl3Id createdAt isExpired }
        total hasMore
      }
    }`
  : `query UserSessions($courseId: Int!, $lessonId: Int!, $fileId: Int!) {
      userSessions(courseId: $courseId, lessonId: $lessonId, fileId: $fileId, limit: 20) {
        items { id sessionName courseId lessonId fileId createdAt isExpired }
        total hasMore
      }
    }`;

const SESSION_MESSAGES_QUERY = useMastra
  ? `query LearnerSessionMessages($sessionId: String!, $limit: Int) {
      learnerSessionMessages(sessionId: $sessionId, limit: $limit) {
        items { id sessionId role content uiMetadata createdAt }
        hasMore
      }
    }`
  : `query SessionMessages($sessionId: Int!, $limit: Int) {
      sessionMessages(sessionId: $sessionId, limit: $limit) {
        items { id sessionId messageContent messageType createdAt }
        hasMore
      }
    }`;

export default function LearnerChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<LearnerSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [scope, setScope] = useState<ScopeType>('lesson_chat');

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchSessions = useCallback(async (activeScope: ScopeType = scope) => {
    setSessionsLoading(true);
    const s = getScopeInput(activeScope);
    try {
      const variables = useMastra
        ? { sessionType: s.sessionType, rsrcId: s.rsrcId, rsrcLvl2Id: s.rsrcLvl2Id, rsrcLvl3Id: s.rsrcLvl3Id }
        : { courseId: s.rsrcId ?? 0, lessonId: s.rsrcLvl2Id ?? 0, fileId: s.rsrcLvl3Id ?? 0 };
      const { data } = await gqlQuery(SESSIONS_QUERY, variables as any);
      const items = useMastra ? data?.learnerSessions?.items : data?.userSessions?.items;
      setSessions(items?.map((s: any) => ({ id: String(s.id), title: s.title ?? s.sessionName, sessionType: s.sessionType, createdAt: s.createdAt, isExpired: s.isExpired })) ?? []);
    } catch (e) {
      console.error('Failed to fetch sessions', e);
    } finally {
      setSessionsLoading(false);
    }
  }, [scope]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const updateMsg = useCallback((id: string, updater: (m: Message) => Partial<Message>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updater(m) } : m));
  }, []);

  const streamChat = useCallback((
    text: string,
    assistantId: string,
    signal: AbortSignal,
    currentSessionId: string | undefined,
    currentScope: ScopeType,
  ) => {
    const messageId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = sseClient.subscribe(
        {
          query: useMastra
            ? `subscription LearnerAiChat($input: LearnerChatInput!) {
                learnerAiChat(input: $input) {
                  type text sources sessionId message
                  intent confidence workflowId workflowType status label
                  workflows milestones actions done
                  data
                }
              }`
            : `subscription LearnerAssistantChat($input: AiChatInput!) {
                learnerAssistantChat(input: $input) {
                  type text sources sessionId message
                }
              }`,
          variables: useMastra
            ? { input: { question: text, messageId, sessionId: currentSessionId, ...getScopeInput(currentScope) } }
            : { input: { question: text, sessionName: 'AI Chat', courseId: getScopeInput(currentScope).rsrcId ?? 0, lessonId: getScopeInput(currentScope).rsrcLvl2Id ?? 0, fileId: getScopeInput(currentScope).rsrcLvl3Id ?? 0, isNewChatSession: !currentSessionId, filters: { courseId: getScopeInput(currentScope).rsrcId, lessonId: getScopeInput(currentScope).rsrcLvl2Id, fileId: getScopeInput(currentScope).rsrcLvl3Id }, sessionId: currentSessionId ? Number(currentSessionId) : 0 } },
        },
        {
          next: ({ data }: any) => {
            const event = useMastra ? data?.learnerAiChat : data?.learnerAssistantChat;
            if (!event) return;
            const { type, text: txt, sources: evtSources, sessionId: evtSessionId, message: msgPayload, milestones: evtMilestones, actions: evtActions, data: evtData } = event;
            if ((type === 'text_chunk' || type === 'chunk') && txt) {
              updateMsg(assistantId, m => ({ content: m.content + txt }));
            } else if (type === 'sources' && evtSources) {
              updateMsg(assistantId, () => ({ sources: evtSources }));
            } else if (type === 'metadata' && evtData?.kind) {
              // Bucket each metadata event by its `kind`, in encounter order.
              // Nth `timestamp` metadata matches the Nth timestamp chip, etc.
              const payload = evtData as InlineMetadata;
              const kind = String(payload.kind);
              updateMsg(assistantId, m => {
                const next = { ...(m.metadata ?? {}) };
                next[kind] = [...(next[kind] ?? []), payload];
                return { metadata: next };
              });
            } else if (type === 'session' && evtSessionId) {
              setSessionId(evtSessionId);
            } else if (type === 'milestone' && evtMilestones) {
              updateMsg(assistantId, () => ({ milestones: evtMilestones }));
            } else if (type === 'actions' && evtActions) {
              updateMsg(assistantId, () => ({ actions: evtActions }));
            } else if (type === 'done') {
              updateMsg(assistantId, () => ({ done: true }));
            } else if (type === 'error') {
              updateMsg(assistantId, () => ({ content: msgPayload ?? 'Something went wrong.', error: true, done: true }));
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
      signal.addEventListener('abort', () => { unsubscribe(); });
    });
  }, [updateMsg]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: userId, role: 'user', content: text, done: true },
      { id: assistantId, role: 'assistant', content: '', done: false },
    ]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(text, assistantId, controller.signal, sessionId ?? undefined, scope);
    } catch {
      // error already reflected in message state
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      fetchSessions(); // refresh session list
    }
  }, [input, isStreaming, sessionId, streamChat, fetchSessions]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const stop = () => { abortRef.current?.abort(); setIsStreaming(false); };
  const clearChat = () => { if (!isStreaming) { setMessages([]); setSessionId(undefined); } };

  const loadSession = async (s: LearnerSession) => {
    if (isStreaming) return;
    setSessionId(s.id);
    setMessages([]);
    try {
      const { data } = await gqlQuery(SESSION_MESSAGES_QUERY, { sessionId: s.id, limit: 50 });
      const items: any[] = data?.learnerSessionMessages?.items ?? [];
      setMessages(items.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        actions: (m as any).uiMetadata?.actions ?? undefined,
        done: true,
      })));
    } catch (e) {
      console.error('Failed to load session messages', e);
    }
  };

  const [sourcesPanel, setSourcesPanel] = useState<Source[] | null>(null);

  return (
    <div style={{ flex: 1, display: 'flex', height: '100%', fontFamily: 'DM Sans, sans-serif' }}>

      {/* Sessions sidebar */}
      <div style={{ width: 240, borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {/* Scope selector */}
        <div style={{ padding: '10px 10px 0', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Scope</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {(['global', 'course_chat', 'lesson_chat'] as ScopeType[]).map((s) => (
              <button key={s} onClick={() => {
                setScope(s);
                setSessionId(undefined);
                setMessages([]);
                fetchSessions(s);
              }}
                style={{ flex: 1, fontSize: 10, fontWeight: 600, padding: '4px 0', borderRadius: 6, border: `1px solid ${scope === s ? '#2563eb' : '#e5e7eb'}`, background: scope === s ? '#2563eb' : '#fff', color: scope === s ? '#fff' : '#6b7280', cursor: 'pointer', fontFamily: 'inherit' }}>
                {s === 'global' ? 'School' : s === 'course_chat' ? 'Course' : 'Lesson'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '8px 14px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>Sessions</span>
          <button
            onClick={() => fetchSessions()}
            disabled={sessionsLoading}
            style={{ fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
          >
            {sessionsLoading ? '…' : '↻'}
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <button
            onClick={() => { if (!isStreaming) { setSessionId(undefined); setMessages([]); } }}
            style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: !sessionId ? '#eff6ff' : 'none', border: 'none', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
          >
            <div style={{ fontWeight: 600, color: '#2563eb' }}>+ New session</div>
          </button>
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => loadSession(s)}
              style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: sessionId === s.id ? '#eff6ff' : 'none', border: 'none', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
            >
              <div style={{ fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.title ?? 'Untitled'}
              </div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                {s.id.slice(0, 8)}… · {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ''}
              </div>
            </button>
          ))}
          {sessions.length === 0 && !sessionsLoading && (
            <div style={{ padding: '20px 14px', fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>No sessions yet</div>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

      {/* Header */}
      <div style={{ borderBottom: '1px solid #e5e7eb', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Learner Chat</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {LEARNER_API}
            {sessionId && <span style={{ marginLeft: 8, color: '#2563eb' }}>● session {sessionId.slice(0, 8)}…</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {sessionId && (
            <button
              onClick={() => { if (!isStreaming) setSessionId(undefined); }}
              disabled={isStreaming}
              style={{ fontSize: 12, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
              New Session
            </button>
          )}
          <button onClick={clearChat} disabled={isStreaming}
            style={{ fontSize: 12, color: '#6b7280', background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
            Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 80, color: '#9ca3af' }}>
            <div style={{ fontSize: 24, fontWeight: 600, color: '#111827', marginBottom: 6 }}>Learner Chat</div>
            <div style={{ fontSize: 15 }}>Ask a question about the lesson</div>
          </div>
        )}
        {messages.map((msg, index) => (
          <div key={msg.id} style={{ maxWidth: 680, margin: '0 auto', padding: '10px 20px', display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {msg.role === 'user' ? (
              <div style={{ background: '#f3f4f6', borderRadius: 16, padding: '12px 18px', maxWidth: '80%', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msg.content}
              </div>
            ) : (
              <AssistantBubble msg={msg} onSuggestion={(s) => { setInput(s); textareaRef.current?.focus(); }} isLast={index === messages.length - 1} onShowSources={setSourcesPanel} />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 20px', flexShrink: 0 }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={onKeyDown}
            placeholder="Ask a question about the lesson…"
            disabled={isStreaming}
            rows={1}
            style={{ flex: 1, resize: 'none', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.6, outline: 'none', overflow: 'hidden', background: '#fff' }}
          />
          {isStreaming ? (
            <button onClick={stop}
              style={{ padding: '10px 18px', background: '#fee2e2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
              Stop
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim()}
              style={{ padding: '10px 18px', background: input.trim() ? '#2563eb' : '#e5e7eb', color: input.trim() ? '#fff' : '#9ca3af', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: input.trim() ? 'pointer' : 'default', fontFamily: 'inherit', flexShrink: 0 }}>
              Send
            </button>
          )}
        </div>
      </div>
      </div> {/* end chat area */}

      {/* Sources panel */}
      {sourcesPanel && (
        <div style={{ width: 300, borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', flexShrink: 0, background: '#fafafa' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff' }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>Sources <span style={{ color: '#9ca3af', fontWeight: 400 }}>({sourcesPanel.length})</span></span>
            <button onClick={() => setSourcesPanel(null)} style={{ fontSize: 16, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sourcesPanel.map((src, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
                  Chunk {i + 1}
                  {src.distance != null && (
                    <span style={{ marginLeft: 6, color: '#d1d5db' }}>· {(src.distance as number).toFixed(3)}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {src.text_chunk ?? src.content ?? JSON.stringify(src)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
