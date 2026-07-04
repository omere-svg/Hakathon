import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { LessonPage } from './pages/LessonPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  // Persisted so the sidebar stays how the user left it across reloads.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('maestro.sidebar') === 'collapsed'; } catch { return false; }
  });
  const toggleSidebar = () => setCollapsed((v) => {
    const next = !v;
    try { localStorage.setItem('maestro.sidebar', next ? 'collapsed' : 'open'); } catch { /* ignore */ }
    return next;
  });

  return (
    <div className="app">
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <main className="main">
        <Routes>
          <Route path="/" element={<LessonPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
