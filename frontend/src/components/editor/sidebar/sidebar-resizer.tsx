"use client";

import { useRef, type RefObject } from "react";

export const SIDEBAR_WIDTH = { default: 368, min: 280, max: 720 };
const STORAGE_KEY = "paper2gather:sidebar-width";
const KEY_STEP = 16;

/** The panel may take at most 60% of the viewport so the paper keeps room. */
export function clampSidebarWidth(width: number): number {
  const max = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.round(window.innerWidth * 0.6)));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH.min, width)));
}

export function loadSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (stored >= SIDEBAR_WIDTH.min && stored <= SIDEBAR_WIDTH.max) return stored;
  } catch {
    // storage may be unavailable (private mode)
  }
  return SIDEBAR_WIDTH.default;
}

export function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // storage may be unavailable (private mode)
  }
}

interface SidebarResizerProps {
  /** The panel being resized; its width is changed directly while dragging and committed on release. */
  panelRef: RefObject<HTMLElement | null>;
  width: number;
  onResize: (width: number) => void;
}

/** Drag handle on the left edge of the right-hand panel. */
export function SidebarResizer({ panelRef, width, onResize }: SidebarResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);

  const end = (el: HTMLElement) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    delete el.dataset.dragging;
    if (d.width !== d.startWidth) onResize(d.width);
    // Nothing to commit: drop the inline width set while dragging so React's value applies again.
    else if (panelRef.current) panelRef.current.style.width = `${width}px`;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="패널 너비 조절"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      title="드래그해서 너비 조절 · 더블클릭하면 기본 너비"
      className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-none"
      onPointerDown={(e) => {
        const panel = panelRef.current;
        if (e.button !== 0 || !panel) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "true";
        const startWidth = Math.round(panel.getBoundingClientRect().width);
        drag.current = { startX: e.clientX, startWidth, width: startWidth };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const panel = panelRef.current;
        if (!d || !panel) return;
        // The panel sits on the right, so moving the pointer left widens it.
        d.width = clampSidebarWidth(d.startWidth + d.startX - e.clientX);
        panel.style.width = `${d.width}px`;
      }}
      onPointerUp={(e) => end(e.currentTarget)}
      onPointerCancel={(e) => end(e.currentTarget)}
      onLostPointerCapture={(e) => end(e.currentTarget)}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(clampSidebarWidth(width + KEY_STEP));
        else if (e.key === "ArrowRight") onResize(clampSidebarWidth(width - KEY_STEP));
        else return;
        e.preventDefault();
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-primary/30 group-focus-visible:bg-ring group-data-[dragging=true]:bg-primary/50" />
    </div>
  );
}
