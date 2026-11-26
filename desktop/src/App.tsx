import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  getAuthState,
  installWebviewErrorReporting,
  onAuthStateChanged,
  onScreenshotShortcut,
  reportWebviewError,
  showScreenshotPanel,
  type AuthStateDto,
} from "./lib/bridge";
import Login from "./routes/Login";
import Home from "./routes/Home";
import Countdown from "./routes/Countdown";
import ShareLink from "./routes/ShareLink";
import Webcam from "./routes/Webcam";
import WebcamControls from "./routes/WebcamControls";
import StopControls from "./routes/StopControls";
import RecordingHint from "./routes/RecordingHint";
import SourceHighlight from "./routes/SourceHighlight";
import WindowSelect from "./routes/WindowSelect";
import AreaSelect from "./routes/AreaSelect";
import NativeStudio from "./routes/NativeStudio";
import Onboarding from "./routes/Onboarding";
import WhatsNew from "./routes/WhatsNew";
import Notes from "./routes/Notes";
import ClipboardHistory from "./routes/ClipboardHistory";
import ScreenshotEditor from "./routes/ScreenshotEditor";
import Viewer from "./routes/Viewer";
import CursorTarget from "./routes/CursorTarget";
import CursorTrail from "./routes/CursorTrail";
import { LOCAL_EDITION } from "./lib/edition";
import LocalEditionGate from "./edition-local/LocalEditionGate";
import FirstLaunchUpdate from "./components/FirstLaunchUpdate";

// The first-launch update screen covers the two windows a fresh install
// shows: the setup window (a first launch opens it instead of the popover)
// and the main popover (loading, sign-in or Home). Other windows never do.
export default function App() {
  const hash = window.location.hash;
  const mainWindow = !LOCAL_EDITION && (hash === "" || hash === "#" || hash === "#onboarding");
  return (
    <>
      <AppRoutes />
      {mainWindow ? <FirstLaunchUpdate /> : null}
    </>
  );
}

function AppRoutes() {
  const t = useTranslations("desktop.app");
  const [hash, setHash] = useState(window.location.hash);
  const [state, setState] = useState<AuthStateDto | null>(null);
  const [localGuest, setLocalGuest] = useState(false);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Crash telemetry: every webview (main + overlays) forwards unhandled
  // errors and promise rejections to Rust → Sentry when configured.
  useEffect(() => installWebviewErrorReporting(), []);

  useEffect(() => {
    if (import.meta.env.VITE_SENTRY_SMOKE_TEST === "1") {
      reportWebviewError("Clipy Sentry smoke test", null, "desktop-webview");
    }
  }, []);

  const isAuxWindow =
    hash === "#countdown" ||
    hash === "#share" ||
    hash === "#webcam" ||
    hash === "#webcam-controls" ||
    hash === "#stop-controls" ||
    hash === "#recording-hint" ||
    hash === "#source-highlight" ||
    hash === "#area-select" ||
    hash === "#window-select" ||
    hash === "#cursor-target" ||
    hash === "#cursor-trail" ||
    hash === "#onboarding" ||
    hash.startsWith("#whats-new") ||
    hash === "#notes" ||
    hash === "#clipboard" ||
    hash === "#screenshot-editor" ||
    hash.startsWith("#viewer") ||
    hash.startsWith("#studio");

  useEffect(() => {
    if (LOCAL_EDITION) return;
    if (isAuxWindow) return;
    let active = true;
    let receivedAuthEvent = false;
    let unlisten: (() => void) | undefined;
    // Windows declared in tauri.conf.json start their webview BEFORE `setup()`
    // has finished calling `.manage()`, so an early command can reject with
    // "state not managed for field `AuthState`". Observed on Windows: the
    // webview called a command 734 ms before `restored desktop auth session`
    // was logged.
    //
    // Treating that rejection as "signed out" showed the Login screen to an
    // already-signed-in user, who then had to sign in on every launch. The
    // failure is transient — the same call succeeds once setup completes —
    // so retry briefly before concluding anything about the session.
    const MAX_ATTEMPTS = 20;
    const RETRY_DELAY_MS = 150;
    let retryTimer: number | undefined;

    const loadAuthState = (attempt: number) => {
      getAuthState()
        .then((next) => {
          if (active && !receivedAuthEvent) setState(next);
        })
        .catch(() => {
          if (!active || receivedAuthEvent) return;
          if (attempt < MAX_ATTEMPTS) {
            retryTimer = window.setTimeout(
              () => loadAuthState(attempt + 1),
              RETRY_DELAY_MS,
            );
            return;
          }
          // Genuinely could not read the session after ~3 s. Signed-out is the
          // safe answer: signing in again works, whereas a stuck spinner does
          // not.
          setState({ signed_in: false, user: null });
        });
    };

    onAuthStateChanged((next) => {
      receivedAuthEvent = true;
      if (active) setState(next);
    })
      .then((fn) => {
        unlisten = fn;
        loadAuthState(0);
      })
      .catch(() => {
        // The listener itself could not be attached; still try to read state.
        loadAuthState(0);
      });
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      unlisten?.();
    };
  }, [isAuxWindow]);

  // Home handles ⌘⇧2 itself. While the popover is still loading or showing
  // Login, nothing else listens, so bring it up rather than swallow the key.
  const homeShown = LOCAL_EDITION || Boolean(state && ((state.signed_in && state.user) || localGuest));
  useEffect(() => {
    if (isAuxWindow || homeShown) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void onScreenshotShortcut(() => {
      showScreenshotPanel().catch(() => {});
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [homeShown, isAuxWindow]);

  if (hash === "#countdown") return <Countdown />;
  if (hash === "#share") return <ShareLink />;
  if (hash === "#webcam") return <Webcam />;
  if (hash === "#webcam-controls") return <WebcamControls />;
  if (hash === "#stop-controls") return <StopControls />;
  if (hash === "#recording-hint") return <RecordingHint />;
  if (hash === "#source-highlight") return <SourceHighlight />;
  if (hash === "#window-select") return <WindowSelect />;
  if (hash === "#area-select") return <AreaSelect />;
  if (hash === "#cursor-target") return <CursorTarget />;
  if (hash === "#cursor-trail") return <CursorTrail />;
  if (hash === "#onboarding") return <Onboarding />;
  if (hash.startsWith("#whats-new")) return <WhatsNew />;
  if (hash === "#notes") return <Notes />;
  if (hash === "#clipboard") return <ClipboardHistory />;
  if (hash === "#screenshot-editor") return <ScreenshotEditor />;
  if (hash.startsWith("#viewer")) return <Viewer />;
  if (hash.startsWith("#studio")) return <NativeStudio />;

  // The local edition has no account: Home opens straight away, once the
  // binary has confirmed it is the local edition too.
  if (LOCAL_EDITION) return <LocalEditionGate />;

  if (!state) {
    return (
      <main className="popover-shell flex h-full flex-col items-center justify-center gap-3 popover-radius">
        <span className="clipy-boot-spinner" aria-hidden="true" />
        <span className="text-xs font-medium tracking-wide text-ink-secondary">
          {t("loading")}
        </span>
      </main>
    );
  }

  if (state.signed_in && state.user) return <Home key={state.user.id} user={state.user} initialLocal={localGuest} />;
  // Signed out, the popover leads with one action: sign in. The guest route
  // into Home is kept because a session that expires or is revoked strands
  // the user's saved local recordings behind this screen, and
  // `local/README.md` promises they can still open those folders. Login only
  // surfaces the link when something is actually saved, and Home's local
  // panel (plus the Rust preflight) still demands a signed-in session for a
  // new capture or a retry.
  return localGuest ? <Home user={null} onCloud={() => setLocalGuest(false)} /> : <Login onLocal={() => setLocalGuest(true)} />;
}
