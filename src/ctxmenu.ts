// filo's context menu: replaces the browser one in every zone of the
// app. Plain DOM, themed, only one menu open at a time.

export interface CtxItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean; // destructive actions: red hover
  action: () => void;
}

export type CtxEntry = CtxItem | "sep";

let current: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  current?.remove();
  current = null;
  cleanup?.();
  cleanup = null;
}

/** Opens the menu at the given (viewport) coordinates, closing any
 *  previous menu. Closes on outside click, Esc, blur or resize. */
export function showContextMenu(
  x: number,
  y: number,
  entries: CtxEntry[],
): void {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const entry of entries) {
    if (entry === "sep") {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
      continue;
    }
    const b = document.createElement("button");
    b.className = "ctx-item" + (entry.danger ? " danger" : "");
    b.disabled = !!entry.disabled;
    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = entry.label;
    b.appendChild(label);
    if (entry.shortcut) {
      const k = document.createElement("span");
      k.className = "ctx-shortcut";
      k.textContent = entry.shortcut;
      b.appendChild(k);
    }
    b.addEventListener("click", () => {
      closeContextMenu();
      entry.action();
    });
    menu.appendChild(b);
  }

  document.body.appendChild(menu);
  // never off-screen
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  current = menu;

  const onDown = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) closeContextMenu();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeContextMenu();
    }
  };
  const onAway = () => closeContextMenu();
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onAway);
  window.addEventListener("resize", onAway);
  cleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onAway);
    window.removeEventListener("resize", onAway);
  };
}
