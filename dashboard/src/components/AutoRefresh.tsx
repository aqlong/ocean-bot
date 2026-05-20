"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Tiny client component that re-fetches the current server-rendered
 *  page on a fixed interval. Drop into a server-rendered layout to
 *  make data feel live without polling-loops or WebSockets.
 *
 *  Pauses when the tab is hidden, saves DB queries + dev-server CPU
 *  + cellular data on phone when the dashboard is in a background tab. */
export function AutoRefresh({ everyMs = 10000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      id = setInterval(() => router.refresh(), everyMs);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [router, everyMs]);
  return null;
}
