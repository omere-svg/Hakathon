import { Route, Routes } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { LessonPage } from './pages/LessonPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<LessonPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
