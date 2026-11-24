import { useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ToastProvider } from "./hooks/useToast";
import { Header, Sidebar } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { APP_ROUTES } from "./routes";
import { useAuth } from "./hooks/useAuth";
import { TimeZoneProvider, useTimeZone } from "./hooks/useTimeZone";
import { OnlineProvider } from "./hooks/useOnline";
import { OfflineBanner } from "./components/patterns";

/** Shown only when Settings could not be read and the browser zone is in use. */
function TimeZoneFallbackNotice() {
  const { source, timeZone } = useTimeZone();
  if (source === "settings") return null;
  return (
    <div className="card" role="status" style={{ padding: "12px 16px", marginBottom: "16px" }}>
      Your Settings could not be loaded, so times are shown in this browser's
      time zone ({timeZone}). Reload the page to try again.
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
        }}
      >
        <div
          className="loading-spinner"
          style={{ width: 32, height: 32 }}
          aria-hidden="true"
        />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="app">
      <Sidebar
        mobileOpen={mobileNavOpen}
        onCloseMobileNav={() => setMobileNavOpen(false)}
      />
      <div className="main-content">
        <Header
          mobileNavOpen={mobileNavOpen}
          onToggleMobileNav={() => setMobileNavOpen((open) => !open)}
        />
        <main className="page" role="main">
          <OfflineBanner />
          <TimeZoneFallbackNotice />
          <Routes>
            {APP_ROUTES.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={route.element}
              />
            ))}
          </Routes>
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <OnlineProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <TimeZoneProvider>
                    <AppLayout />
                  </TimeZoneProvider>
                </ProtectedRoute>
              }
            />
          </Routes>
        </OnlineProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

export default App;
