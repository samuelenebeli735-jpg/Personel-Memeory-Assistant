import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ToastProvider } from './hooks/useToast'
import { Header, Sidebar } from './components/Layout'
import { LoginPage } from './pages/Login'
import { OverviewPage } from './pages/Overview'
import { CapturePage } from './pages/Capture'
import { TasksPage } from './pages/Tasks'
import { RemindersPage } from './pages/Reminders'
import { NotesPage } from './pages/Notes'
import { IdeasPage } from './pages/Ideas'
import { EventsPage } from './pages/Events'
import { ProjectsPage } from './pages/Projects'
import { SearchPage } from './pages/Search'
import { SettingsPage } from './pages/Settings'
import { useAuth } from './hooks/useAuth'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="loading-spinner" style={{ width: 32, height: 32 }} aria-hidden="true" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function AppLayout() {
  return (
    <div className="app">
      <Sidebar />
      <div className="main-content">
        <Header />
        <main className="page" role="main">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/capture" element={<CapturePage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/reminders" element={<RemindersPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/ideas" element={<IdeasPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          />
        </Routes>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App