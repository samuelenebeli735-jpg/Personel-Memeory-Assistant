import { useState } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ToastProvider } from "./hooks/useToast";
import { Header, Sidebar } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { APP_ROUTES } from "./routes";
import { useAuth } from "./hooks/useAuth";
import { TimeZoneProvider, useTimeZone } from "./hooks/useTimeZone";
import { OnlineProvider } from "./hooks/useOnline";
import { OfflineBanner } from "./components/patterns";
import { Dialog } from "./components/Dialog";
import { Button } from "./components/ui";

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

/**
 * Shown when the session check could not reach Recall after its retries
 * (429, 5xx, network or timeout). It never sends the owner to the login page:
 * only a 401 means signed out.
 */
function CantReachRecall() {
  const { retrySession } = useAuth();
  return (
    <div className="center-screen">
      <div className="card state-error" role="alert" style={{ maxWidth: 420 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Can’t reach Recall</h1>
        <p style={{ margin: 0 }}>
          Recall didn’t answer, so we can’t tell whether you’re signed in. Your
          session hasn’t been changed.
        </p>
        <div>
          <Button type="button" onClick={() => void retrySession()}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A protected request answered 401 while the page was open. The page stays
 * underneath until the owner chooses to sign in again, so they know before
 * any unsaved text is lost; after signing in they return to this page.
 */
function SessionExpiredDialog() {
  const { sessionExpired, acknowledgeSignedOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const signIn = () => {
    acknowledgeSignedOut();
    navigate("/login", { replace: true, state: { from: location.pathname + location.search } });
  };
  return (
    <Dialog
      open={sessionExpired}
      title="You’ve been signed out"
      role="alertdialog"
      showCloseButton={false}
      onRequestClose={() => undefined}
    >
      <div className="modal-body">
        <p style={{ margin: 0 }}>
          Your session ended. Anything on this page that you haven’t saved will
          be lost when you sign in again; copy it first if you need it.
        </p>
      </div>
      <div className="modal-footer">
        <Button type="button" onClick={signIn}>
          Sign in again
        </Button>
      </div>
    </Dialog>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "unreachable") {
    return <CantReachRecall />;
  }

  if (status === "loading") {
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

  if (status !== "authenticated") {
    // Keep the intended URL so signing in returns here.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return (
    <>
      {children}
      <SessionExpiredDialog />
    </>
  );
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
