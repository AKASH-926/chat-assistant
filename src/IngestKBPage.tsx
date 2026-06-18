import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── API config ───────────────────────────────────────────────────────────────

const isLocalHost = false
const API_BASE_URL = isLocalHost ? 'http://localhost:3001' : 'https://ai-api-dev.learnyst.com';
const GRAPHQL_API = `${API_BASE_URL}/admin-ai`;
const AUTH_TOKEN = `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjc5MzA0MTcsInNpZCI6MTUyNDMyLCJleHAiOjE4MDg2NDA1ODUsInR5cCI6NCwibG9rIjoiMDAwMCIsImlzQWRtaW4iOnRydWUsInRvayI6IjdCSmtPaWRudXlDU3BkcXFVdmwtS3ciLCJ0aW1lIjoxNzc2ODQ1Mzg1fQ.l6nz7zafs82h08DmE9rKmh5nmls5bIef3sTR_GUWDu4`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface IngestResult {
  jobId: string;
  status: string;
}

interface KbArticle {
  id: number;
  slug: string;
  category: string;
  description: string;
  ingestionStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

const PAGE_SIZE = 10;

// ─── Animations (injected once) ───────────────────────────────────────────────
const styleTag = document.createElement('style');
styleTag.textContent = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');

  @keyframes kb-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes kb-pulse-dot {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
  @keyframes kb-slide-up {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes kb-crawl {
    0% { width: 0%; }
    40% { width: 60%; }
    70% { width: 80%; }
    90% { width: 92%; }
    100% { width: 100%; }
  }
  @keyframes kb-shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .kb-ingest-btn:hover:not(:disabled) {
    background: #15803d !important;
    box-shadow: 0 4px 16px rgba(22, 163, 74, 0.35) !important;
    transform: translateY(-1px);
  }
  .kb-ingest-btn:active:not(:disabled) {
    transform: translateY(0);
  }
  .kb-back-btn:hover {
    background: #f3f4f6 !important;
    color: #111827 !important;
  }
  .kb-url-input:focus {
    border-color: #16a34a !important;
    box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.12) !important;
  }
`;
if (!document.head.querySelector('#kb-styles')) {
  styleTag.id = 'kb-styles';
  document.head.appendChild(styleTag);
}

// ─── Spinner component ────────────────────────────────────────────────────────
function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ animation: 'kb-spin 0.8s linear infinite', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
      <path d="M12 2 a10 10 0 0 1 10 10" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Crawl progress bar ───────────────────────────────────────────────────────
function CrawlProgress() {
  return (
    <div style={{ marginTop: 24, animation: 'kb-slide-up 0.4s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Crawling & Ingesting</span>
        <span style={{ display: 'flex', gap: 4 }}>
          {[0, 150, 300].map(delay => (
            <span key={delay} style={{
              width: 6, height: 6, borderRadius: '50%', background: '#16a34a',
              display: 'inline-block',
              animation: `kb-pulse-dot 1.2s ${delay}ms ease-in-out infinite`,
            }} />
          ))}
        </span>
      </div>
      <div style={{ height: 4, background: '#f3f4f6', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 99,
          background: 'linear-gradient(90deg, #16a34a, #4ade80)',
          animation: 'kb-crawl 8s ease-out forwards',
        }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#9ca3af' }}>
        Fetching and indexing content from the URL…
      </div>
    </div>
  );
}

// ─── Result card ──────────────────────────────────────────────────────────────
function ResultCard({ result, isError, onRefresh, refreshing }: { result: IngestResult | null; isError?: boolean; onRefresh?: () => void; refreshing?: boolean }) {
  if (!result && !isError) return null;

  if (isError) {
    return (
      <div style={{
        marginTop: 24, borderRadius: 12, border: '1px solid #fecaca',
        background: '#fef2f2', padding: '16px 20px',
        animation: 'kb-slide-up 0.35s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#dc2626' }}>Ingestion Failed</span>
        </div>
        <p style={{ fontSize: 13, color: '#b91c1c', margin: 0, lineHeight: 1.5 }}>
          Could not connect to the API. Check the endpoint and try again.
        </p>
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 24, borderRadius: 12, border: '1px solid #bbf7d0',
      background: '#f0fdf4', padding: '20px',
      animation: 'kb-slide-up 0.35s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%', background: '#16a34a',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#15803d' }}>Ingestion Job Queued</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#fff', borderRadius: 8, border: '1px solid #d1fae5' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Job ID</span>
          <span style={{ fontSize: 13, fontFamily: 'DM Mono, monospace', fontWeight: 500, color: '#111827', letterSpacing: '0.02em' }}>{result!.jobId}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#fff', borderRadius: 8, border: '1px solid #d1fae5' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</span>
          <span style={{
            fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 99,
            background: (() => { const s = result!.status.toLowerCase(); return s === 'completed' ? '#dcfce7' : s === 'failed' ? '#fee2e2' : s === 'in_progress' ? '#fef3c7' : '#f3f4f6'; })(),
            color: (() => { const s = result!.status.toLowerCase(); return s === 'completed' ? '#15803d' : s === 'failed' ? '#dc2626' : s === 'in_progress' ? '#92400e' : '#6b7280'; })(),
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            {result!.status}
          </span>
        </div>
      </div>

      {/* Refresh Status button */}
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            marginTop: 16, width: '100%', padding: '10px 0',
            background: 'none', border: '1.5px solid #d1fae5', borderRadius: 10,
            fontSize: 13, fontWeight: 600, color: '#15803d',
            cursor: refreshing ? 'default' : 'pointer',
            fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            transition: 'all 0.15s', opacity: refreshing ? 0.6 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            style={{ animation: refreshing ? 'kb-spin 0.8s linear infinite' : 'none' }}>
            <path d="M21.5 2v6h-6M2.5 22v-6h6" />
            <path d="M2.5 11.5a10 10 0 0 1 18.37-4.5M21.5 12.5a10 10 0 0 1-18.37 4.5" />
          </svg>
          {refreshing ? 'Checking…' : 'Refresh Status'}
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function IngestKBPage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [isError, setIsError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [articlesTotal, setArticlesTotal] = useState(0);
  const [articlesPage, setArticlesPage] = useState(1);
  const [articlesHasMore, setArticlesHasMore] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchArticles = useCallback(async (page = 1) => {
    setArticlesLoading(true);
    try {
      const res = await fetch(GRAPHQL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_TOKEN },
        body: JSON.stringify({
          query: `query KbArticles($limit: Int, $page: Int) { kbArticles(limit: $limit, page: $page) { items { id slug category description ingestionStatus createdAt updatedAt } total hasMore } }`,
          variables: { limit: PAGE_SIZE, page },
        }),
      });
      const json = await res.json();
      const data = json.data?.kbArticles;
      if (data) {
        setArticles(data.items);
        setArticlesTotal(data.total);
        setArticlesHasMore(data.hasMore);
        setArticlesPage(page);
      }
    } catch { /* ignore */ }
    finally { setArticlesLoading(false); }
  }, []);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  const isValidUrl = (() => {
    try { new URL(url); return true; } catch { return false; }
  })();

  async function handleIngest() {
    if (!isValidUrl || loading) return;
    setLoading(true);
    setResult(null);
    setIsError(false);

    try {
      const res = await fetch(GRAPHQL_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': AUTH_TOKEN,
        },
        body: JSON.stringify({
          query: `mutation CrawlAndIngest($url: String!) {
            crawlAndIngestKb(url: $url) {
              jobId
              status
            }
          }`,
          variables: { url },
        }),
      });

      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors[0].message);
      const data = json.data?.crawlAndIngestKb;
      if (!data) throw new Error('Empty response');
      setResult(data);
      fetchArticles();
    } catch {
      setIsError(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshStatus() {
    if (!result?.jobId || refreshing) return;
    setRefreshing(true);
    try {
      // Derive slug from the ingested URL (last path segment, without trailing slash)
      const slug = new URL(url).pathname.replace(/\/+$/, '').split('/').pop() || '';
      if (!slug) return;
      const res = await fetch(GRAPHQL_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': AUTH_TOKEN,
        },
        body: JSON.stringify({
          query: `query KbIngestionStatus($slug: String!) {
            kbIngestionStatus(slug: $slug) {
              id slug status errorReason createdAt updatedAt
            }
          }`,
          variables: { slug },
        }),
      });
      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors[0].message);
      const data = json.data?.kbIngestionStatus;
      if (data) {
        setResult({ jobId: result.jobId, status: data.status });
      } else {
        // Record not yet created by the worker — still queued
        setResult({ jobId: result.jobId, status: 'QUEUED' });
      }
    } catch {
      // silently fail — keep showing the last known status
    } finally {
      setRefreshing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleIngest();
  }

  function handleReset() {
    setUrl('');
    setResult(null);
    setIsError(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: '100vh',
      fontFamily: 'DM Sans, sans-serif', background: '#fff',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        borderBottom: '1px solid #e5e7eb', padding: '12px 24px',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <button
          className="kb-back-btn"
          onClick={() => navigate('/')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 13, color: '#6b7280', background: 'none',
            border: '1px solid #e5e7eb', borderRadius: 8, padding: '5px 12px',
            cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Chat
        </button>

        <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8, background: '#f0fdf4',
            border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>Ingest Knowledge Base</span>
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '64px 24px 48px',
      }}>
        <div style={{ width: '100%', maxWidth: 560 }}>

          {/* Page heading */}
          <div style={{ marginBottom: 40 }}>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: '#111827', margin: '0 0 8px', lineHeight: 1.25 }}>
              Crawl & Ingest URL
            </h1>
            <p style={{ fontSize: 15, color: '#6b7280', margin: 0, lineHeight: 1.6 }}>
              Provide a URL to crawl its content and add it to the knowledge base.
              The ingestion job runs asynchronously in the background.
            </p>
          </div>

          {/* Form card */}
          <div style={{
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16,
            padding: 28, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Source URL
            </label>
            <input
              ref={inputRef}
              className="kb-url-input"
              type="url"
              value={url}
              onChange={e => { setUrl(e.target.value); setResult(null); setIsError(false); }}
              onKeyDown={handleKeyDown}
              placeholder="https://support.learnyst.com/..."
              disabled={loading}
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '12px 16px', fontSize: 14,
                fontFamily: 'DM Mono, monospace',
                border: '1.5px solid #e5e7eb', borderRadius: 10,
                outline: 'none', color: '#111827', background: '#fafafa',
                transition: 'border-color 0.15s, box-shadow 0.15s',
                opacity: loading ? 0.6 : 1,
              }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <button
                className="kb-ingest-btn"
                onClick={handleIngest}
                disabled={!isValidUrl || loading}
                style={{
                  flex: 1, padding: '12px 24px',
                  background: isValidUrl && !loading ? '#16a34a' : '#e5e7eb',
                  color: isValidUrl && !loading ? '#fff' : '#9ca3af',
                  border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
                  cursor: isValidUrl && !loading ? 'pointer' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  transition: 'all 0.2s',
                  fontFamily: 'inherit',
                }}
              >
                {loading ? (
                  <>
                    <Spinner />
                    Ingesting…
                  </>
                ) : (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Start Ingestion
                  </>
                )}
              </button>

              {(result || isError) && (
                <button
                  onClick={handleReset}
                  style={{
                    padding: '12px 18px', background: 'none', border: '1.5px solid #e5e7eb',
                    borderRadius: 10, fontSize: 14, color: '#6b7280', cursor: 'pointer',
                    fontFamily: 'inherit', transition: 'all 0.15s',
                  }}
                >
                  Reset
                </button>
              )}
            </div>

            {/* Progress / Result */}
            {loading && <CrawlProgress />}
            {!loading && <ResultCard result={result} isError={isError} onRefresh={result ? handleRefreshStatus : undefined} refreshing={refreshing} />}
          </div>

          {/* Helper text */}
          <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 20, lineHeight: 1.6, textAlign: 'center' }}>
            The crawler will follow links within the same domain. Large sites may take several minutes to fully index.
          </p>

          {/* ── Ingested articles list ── */}
          <div style={{ marginTop: 48 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 }}>Ingested Articles</h2>
                {articlesTotal > 0 && (
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>{articlesTotal} total</span>
                )}
              </div>
              <button
                onClick={() => fetchArticles(articlesPage)}
                disabled={articlesLoading}
                style={{
                  fontSize: 12, color: '#6b7280', background: 'none', border: '1px solid #e5e7eb',
                  borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 5, opacity: articlesLoading ? 0.5 : 1,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                  style={{ animation: articlesLoading ? 'kb-spin 0.8s linear infinite' : 'none' }}>
                  <path d="M21.5 2v6h-6M2.5 22v-6h6" />
                  <path d="M2.5 11.5a10 10 0 0 1 18.37-4.5M21.5 12.5a10 10 0 0 1-18.37 4.5" />
                </svg>
                Refresh
              </button>
            </div>

            {articlesLoading && articles.length === 0 && (
              <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            )}

            {!articlesLoading && articles.length === 0 && (
              <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 13 }}>No articles ingested yet.</div>
            )}

            {articles.length > 0 && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                {/* Table header */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr auto auto',
                  padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
                  fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  <span>Slug</span>
                  <span style={{ textAlign: 'center', minWidth: 90 }}>Status</span>
                  <span style={{ textAlign: 'right', minWidth: 120 }}>Updated</span>
                </div>

                {/* Rows */}
                {articles.map((a, i) => {
                  const s = (a.ingestionStatus ?? '').toLowerCase();
                  const statusBg = s === 'completed' ? '#dcfce7' : s === 'failed' ? '#fee2e2' : s === 'in_progress' ? '#fef3c7' : '#f3f4f6';
                  const statusColor = s === 'completed' ? '#15803d' : s === 'failed' ? '#dc2626' : s === 'in_progress' ? '#92400e' : '#6b7280';
                  return (
                    <div key={a.id} style={{
                      display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center',
                      padding: '12px 16px', borderBottom: i < articles.length - 1 ? '1px solid #f3f4f6' : 'none',
                      background: '#fff',
                    }}>
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.slug}
                        </div>
                        {a.category && (
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{a.category}</div>
                        )}
                      </div>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                        background: statusBg, color: statusColor, textTransform: 'uppercase', letterSpacing: '0.04em',
                        textAlign: 'center', minWidth: 90,
                      }}>
                        {a.ingestionStatus ?? '—'}
                      </span>
                      <span style={{ fontSize: 12, color: '#9ca3af', textAlign: 'right', minWidth: 120 }}>
                        {new Date(a.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination */}
            {articlesTotal > PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
                <button
                  onClick={() => fetchArticles(articlesPage - 1)}
                  disabled={articlesPage <= 1 || articlesLoading}
                  style={{
                    fontSize: 13, fontWeight: 500, color: articlesPage <= 1 ? '#d1d5db' : '#374151',
                    background: 'none', border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 14px',
                    cursor: articlesPage <= 1 ? 'default' : 'pointer', fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 4, opacity: articlesLoading ? 0.5 : 1,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Previous
                </button>
                <span style={{ fontSize: 13, color: '#6b7280' }}>
                  Page {articlesPage} of {Math.ceil(articlesTotal / PAGE_SIZE)}
                </span>
                <button
                  onClick={() => fetchArticles(articlesPage + 1)}
                  disabled={!articlesHasMore || articlesLoading}
                  style={{
                    fontSize: 13, fontWeight: 500, color: !articlesHasMore ? '#d1d5db' : '#374151',
                    background: 'none', border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 14px',
                    cursor: !articlesHasMore ? 'default' : 'pointer', fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 4, opacity: articlesLoading ? 0.5 : 1,
                  }}
                >
                  Next
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
