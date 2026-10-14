import { storage } from "./storage.ts";

export type PanelTab = "browser" | "schedules" | "memory" | "snapshots" | "settings";
export const PANEL_KEY = "nibblet.panel";
const EVENT = "nibblet:panel";

/**
 * Opens a side panel on the nibblet page, whether or not that page is
 * already showing: it's remembered for the next page and announced to the
 * current one.
 */
export function openPanel(tab: PanelTab): void {
  storage.set(PANEL_KEY, tab);
  window.dispatchEvent(new CustomEvent<PanelTab>(EVENT, { detail: tab }));
}

/** Calls back whenever something asks for a panel; returns an unsubscribe. */
export function onPanelRequest(listener: (tab: PanelTab) => void): () => void {
  const handler = (e: Event) => {
    if (e instanceof CustomEvent && isPanelTab(e.detail)) listener(e.detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

export function isPanelTab(value: unknown): value is PanelTab {
  return (
    value === "browser" ||
    value === "schedules" ||
    value === "memory" ||
    value === "snapshots" ||
    value === "settings"
  );
}
