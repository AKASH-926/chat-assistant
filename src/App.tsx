import { HashRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import ChatAssistantPage from './ChatAssistantPage';
import LearnerChatPage from './LearnerChatPage';
import IngestKBPage from './IngestKBPage';

type Tab = 'admin-chat' | 'learner-chat';

const TABS: { id: Tab; label: string; path: string }[] = [
  { id: 'admin-chat', label: 'Admin Chat', path: '/' },
  { id: 'learner-chat', label: 'Learner Chat', path: '/learner-chat' },
];

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const currentTab = TABS.find(t => t.path === location.pathname)?.id ?? 'admin-chat';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'DM Sans, sans-serif', background: '#fff' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0 }}>
        {TABS.map(tab => {
          const active = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => navigate(tab.path)}
              style={{
                padding: '10px 20px',
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? '#111827' : '#6b7280',
                background: 'none',
                border: 'none',
                borderBottom: active ? '2px solid #111827' : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                marginBottom: -1,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Page content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <Routes>
          <Route path="/" element={<ChatAssistantPage />} />
          <Route path="/learner-chat" element={<LearnerChatPage />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/ingest-kb" element={<IngestKBPage />} />
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </HashRouter>
  );
}
