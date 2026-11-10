"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** A `<details>` popover that closes on an outside click, outside focus or Escape. */
export function LoopMenu({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => { if (ref.current) ref.current.open = false; };
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      // Select menus render in a portal outside the panel that opened them.
      if (target instanceof Element && target.closest(".select-positioner")) return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); };
  }, [open]);
  return <details ref={ref} className={className} onToggle={e => setOpen(e.currentTarget.open)}
    onKeyDown={e => {
      if (e.key !== "Escape" || e.defaultPrevented || !e.currentTarget.open) return;
      e.stopPropagation();
      e.currentTarget.open = false;
      e.currentTarget.querySelector("summary")?.focus();
    }}>{children}</details>;
}
