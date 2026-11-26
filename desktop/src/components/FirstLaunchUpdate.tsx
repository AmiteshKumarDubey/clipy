import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import ClipyMarkMotion from "./ClipyMarkMotion";
import {
  getFirstLaunchUpdate,
  onFirstLaunchUpdate,
  type FirstLaunchUpdateDto,
} from "../lib/bridge";

/**
 * Covers the popover while a fresh install moves to the newest release
 * (updater.rs, "Update on first launch"). Rust drives it: a `downloading`
 * state with optional progress, then `installing`, after which the app
 * restarts. Null hides it, including when the step fails, so the person is
 * never left on this screen.
 */
export default function FirstLaunchUpdate() {
  const t = useTranslations("desktop.app.firstLaunchUpdate");
  const [info, setInfo] = useState<FirstLaunchUpdateDto | null>(null);

  useEffect(() => {
    let active = true;
    // Once any event has arrived it is the latest word, including a null that
    // hides the screen; the snapshot read below may be older than it.
    let eventSeen = false;
    let unlisten: (() => void) | undefined;
    void onFirstLaunchUpdate((next) => {
      eventSeen = true;
      if (active) setInfo(next);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
      // Read after listening, so a state set in between is not missed.
      void getFirstLaunchUpdate().then((current) => {
        if (active && !eventSeen) setInfo(current);
      });
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  if (!info) return null;
  const installing = info.phase === "installing";
  const percent = installing ? 100 : info.percent;

  return (
    <div
      role="alertdialog"
      aria-live="polite"
      aria-label={t("title")}
      className="popover-shell popover-radius fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-4 px-8 text-center"
    >
      <ClipyMarkMotion className="h-14 w-14" />
      <div>
        <h1 className="text-[15px] font-semibold text-ink-text">{t("title")}</h1>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">
          {installing ? t("installing") : t("body", { version: info.version })}
        </p>
      </div>
      <div className="w-full max-w-[240px]">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-flash-500/15"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          {percent == null ? (
            <div className="first-launch-update-indeterminate h-full w-1/3 rounded-full bg-flash-500" />
          ) : (
            <div
              className="h-full rounded-full bg-flash-500 transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
        {percent != null && !installing ? (
          <p className="mt-1.5 text-[11px] tabular-nums text-ink-secondary">
            {t("percent", { percent })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
