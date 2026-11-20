"use client";

import { useEffect, useState } from "react";
import { blockInnerFocusApp, INNER_FOCUS_CHANGED, innerFocusBlockedUntil, innerFocusWindow, readInnerFocusRule } from "@/lib/inner-focus";

export function useInnerFocus(id: string | null, label: string, onNotice: (text: string) => void): number {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!id || !label) return;
    let since: number | null = null;
    let runAt = 0;
    let warned = false;
    let timer = 0;
    const initialNow = Date.now();
    let displayingBlock = innerFocusWindow(id, label, readInnerFocusRule(), initialNow) && innerFocusBlockedUntil(id, initialNow) > 0;
    const reset = () => { since = null; warned = false; };
    const tick = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible") { reset(); return; }
      const now = Date.now();
      const rule = readInnerFocusRule();
      const eligible = innerFocusWindow(id, label, rule, now);
      if (!eligible || !rule) {
        reset();
        if (displayingBlock) { displayingBlock = false; refresh(value => value + 1); }
        if (rule && rule.ids.includes(id) && rule.until > now) timer = window.setTimeout(tick, 1000);
        return;
      }
      const blockedUntil = innerFocusBlockedUntil(id, now);
      if (blockedUntil) {
        reset();
        if (!displayingBlock) { displayingBlock = true; refresh(value => value + 1); }
        timer = window.setTimeout(tick, Math.min(1000, blockedUntil - now));
        return;
      }
      const elapsedNow = performance.now();
      if (since === null || elapsedNow - runAt > 10_000) { reset(); since = elapsedNow; }
      runAt = elapsedNow;
      const elapsed = elapsedNow - since;
      if (!warned && elapsed >= 180_000) {
        warned = true;
        onNotice(`「${label}」已连续使用 3 分钟。可以先回去复习。`);
      }
      if (elapsed >= 300_000) {
        blockInnerFocusApp(id, Math.min(now + 25 * 60_000, rule.until), now);
        displayingBlock = true;
        reset();
        refresh(value => value + 1);
      } else if (displayingBlock) {
        displayingBlock = false;
        refresh(value => value + 1);
      }
      timer = window.setTimeout(tick, 1000);
    };
    const restart = () => { reset(); tick(); };
    const suspend = () => { window.clearTimeout(timer); reset(); };
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", restart);
    window.addEventListener(INNER_FOCUS_CHANGED, restart);
    window.addEventListener("phone-check-config-changed", restart);
    tick();
    return () => {
      suspend();
      document.removeEventListener("visibilitychange", restart);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", restart);
      window.removeEventListener(INNER_FOCUS_CHANGED, restart);
      window.removeEventListener("phone-check-config-changed", restart);
    };
  }, [id, label, onNotice]);

  const now = Date.now();
  return id && innerFocusWindow(id, label, readInnerFocusRule(), now) ? innerFocusBlockedUntil(id, now) : 0;
}
