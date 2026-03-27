import { useState } from 'react';
import ChatAssistantPage from './ChatAssistantPage';
import IngestKBPage from './IngestKBPage';

type Page = 'chat' | 'ingest-kb';

export default function App() {
  const [page, setPage] = useState<Page>('chat');

  if (page === 'ingest-kb') {
    return <IngestKBPage onBack={() => setPage('chat')} />;
  }

  return <ChatAssistantPage onNavigate={setPage} />;
}
