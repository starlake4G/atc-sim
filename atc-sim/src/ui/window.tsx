import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

interface Rect { x: number; y: number; width: number; height: number }
const storageKey = (id: string) => `kestrel.window.v1.${id}`;
function fit(rect: Rect): Rect {
  const width = Math.max(180, Math.min(rect.width, innerWidth - 24));
  const height = Math.max(56, Math.min(rect.height, innerHeight - 68));
  return { width, height, x: Math.max(8, Math.min(rect.x, innerWidth - width - 8)), y: Math.max(48, Math.min(rect.y, innerHeight - height - 8)) };
}
function read(id: string): Rect | null {
  try { const value = JSON.parse(localStorage.getItem(storageKey(id)) ?? "null"); return value && [value.x, value.y, value.width, value.height].every(Number.isFinite) ? innerWidth <= 760 ? value : fit(value) : null; } catch { return null; }
}
function save(id: string, rect: Rect) { try { localStorage.setItem(storageKey(id), JSON.stringify(rect)); } catch { /* Layout remains usable in memory. */ } }

export function WorkspaceWindow({ id, editing, resetToken, children }: { id: string; editing: boolean; resetToken: number; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(() => read(id));
  const [compact, setCompact] = useState(innerWidth <= 760);
  const floating = !!rect && !compact;
  const latest = useRef(rect); latest.current = rect;
  const drag = useRef<{ x: number; y: number; rect: Rect; resize: boolean } | null>(null);
  const lastReset = useRef(resetToken);
  useLayoutEffect(() => {
    if (compact || !editing || rect || !element.current?.firstElementChild) return;
    const bounds = element.current.firstElementChild.getBoundingClientRect();
    const initial = fit({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    setRect(initial); save(id, initial);
  }, [editing]);
  useEffect(() => {
    if (resetToken === lastReset.current) return;
    lastReset.current = resetToken;
    setRect(null); try { localStorage.removeItem(storageKey(id)); } catch { /* Keep default layout. */ }
  }, [resetToken, id]);
  useEffect(() => {
    const resize = () => { setCompact(innerWidth <= 760); if (innerWidth > 760) setRect((current) => current ? fit(current) : null); };
    window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  function start(event: PointerEvent<HTMLDivElement>) {
    if (compact || !editing || !rect) return;
    const target = event.target as Element;
    const resize = !!target.closest("[data-resize]");
    if (!resize && (!target.closest(".panel-title") || target.closest("button"))) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { x: event.clientX, y: event.clientY, rect, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current; if (!active) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    const next = fit(active.resize ? { ...active.rect, width: active.rect.width + dx, height: active.rect.height + dy } : { ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy });
    latest.current = next; setRect(next);
  }
  function stop() { if (drag.current && latest.current) save(id, latest.current); drag.current = null; }
  return <div ref={element} data-window={id} className={`workspace-window ${floating ? "floating" : ""} ${editing && !compact ? "editing" : ""}`} style={floating && rect ? { position: "fixed", left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: editing ? 12 : 4 } : undefined} onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}>
    {children}{editing && floating && <div className="window-resize" data-resize title="拖动调整窗口大小" />}
  </div>;
}
