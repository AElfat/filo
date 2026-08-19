// filo's minimal UI components: modal windows and the tab bar.
// All plain DOM, no framework: consistent with the lightweight philosophy.

import { t } from "./i18n";

export interface ModalButton {
  id: string;
  label: string;
  primary?: boolean;
}

/** Shows a modal and resolves with the id of the pressed button
 *  (or "annulla" if Esc is pressed). */
export function modal(
  title: string,
  body: HTMLElement | string,
  buttons: ModalButton[],
): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box";

    const h = document.createElement("h2");
    h.textContent = title;
    box.appendChild(h);

    if (typeof body === "string") {
      const p = document.createElement("p");
      p.textContent = body;
      box.appendChild(p);
    } else {
      box.appendChild(body);
    }

    const row = document.createElement("div");
    row.className = "modal-buttons";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      if (b.primary) btn.className = "primary";
      btn.addEventListener("click", () => close(b.id));
      row.appendChild(btn);
    }
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // preventDefault: the key's default action must not reach
        // the editor, which gets refocused right after
        e.preventDefault();
        e.stopPropagation();
        close("annulla");
      } else if (e.key === "Enter") {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(primary.id);
        }
      }
    }
    function close(id: string) {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(id);
    }
    window.addEventListener("keydown", onKey, true);
    (row.querySelector("button.primary") as HTMLButtonElement | null)?.focus();
  });
}

/** Modal with a navigable list of choices; resolves with the chosen
 *  index or -1 if cancelled. */
export function pickerModal(
  title: string,
  items: { label: string; detail?: string }[],
): Promise<number> {
  return new Promise((resolve) => {
    const list = document.createElement("div");
    list.className = "picker-list";
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.className = "picker-item";
      const l = document.createElement("span");
      l.textContent = item.label;
      row.appendChild(l);
      if (item.detail) {
        const d = document.createElement("span");
        d.className = "picker-detail";
        d.textContent = item.detail;
        row.appendChild(d);
      }
      row.addEventListener("click", () => {
        done(i);
      });
      list.appendChild(row);
    });

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box";
    const h = document.createElement("h2");
    h.textContent = title;
    box.appendChild(h);
    box.appendChild(list);
    const row = document.createElement("div");
    row.className = "modal-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = t("btn.cancel");
    cancel.addEventListener("click", () => done(-1));
    row.appendChild(cancel);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(-1);
      }
    }
    function done(i: number) {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(i);
    }
    window.addEventListener("keydown", onKey, true);
    (list.firstElementChild as HTMLButtonElement | null)?.focus();
  });
}

export interface TabInfo {
  id: string;
  title: string;
  dirty: boolean;
  active: boolean;
  fixed?: boolean; // not draggable (Settings tab)
}

export interface TabHandlers {
  select(id: string): void;
  close(id: string): void;
  /** Tab `id` was dragged before `beforeId` (to the end if null). */
  reorder?(id: string, beforeId: string | null): void;
}

export function renderTabs(
  container: HTMLElement,
  tabs: TabInfo[],
  h: TabHandlers,
) {
  const tabCloseTip = t("tab.close.tip");
  container.replaceChildren();
  for (const t of tabs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (t.active ? " active" : "");
    tab.title = t.title;
    tab.dataset.id = t.id; // for the tabs' context menu

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = `${t.title}${t.dirty ? " •" : ""}`;
    tab.appendChild(label);

    const x = document.createElement("button");
    x.className = "tab-close";
    x.textContent = "×";
    x.title = tabCloseTip;
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      h.close(t.id);
    });
    tab.appendChild(x);

    let dragged = false;
    tab.addEventListener("click", () => {
      if (!dragged) h.select(t.id);
    });
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) h.close(t.id); // middle click = close
    });

    // Drag-to-reorder (pointer events: HTML5 drag is swallowed by
    // Tauri's file drag&drop). The tab moves live among its siblings;
    // on release the order is committed.
    if (h.reorder && !t.fixed) {
      tab.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest(".tab-close")) return;
        const startX = e.clientX;
        // grab point: the tab follows the pointer from where it was grabbed
        const grabOffset = e.clientX - tab.getBoundingClientRect().left;
        let translate = 0;
        dragged = false;

        // NO pointer capture: moving the tab with insertBefore is a
        // "remove + reinsert" that would lose it. Events are listened
        // to on the document, which receives them all anyway.
        const onMove = (ev: PointerEvent) => {
          if (ev.buttons === 0) {
            // button released outside the window: wrap up here
            onUp();
            return;
          }
          if (!dragged) {
            if (Math.abs(ev.clientX - startX) < 5) return;
            dragged = true;
            tab.classList.add("dragging");
          }
          // the tab slides with the pointer (transform, no reflow)…
          const follow = () => {
            const slotLeft = tab.getBoundingClientRect().left - translate;
            translate = ev.clientX - grabOffset - slotLeft;
            tab.style.transform = `translateX(${translate}px)`;
          };
          follow();
          // …and changes slot when it passes a sibling's center
          const after = [...container.children].find(
            (s) =>
              s !== tab &&
              !(s as HTMLElement).classList.contains("tab-fixed") &&
              ev.clientX <
                s.getBoundingClientRect().left + (s as HTMLElement).offsetWidth / 2,
          );
          const target = after ?? null;
          if (target !== tab.nextElementSibling) {
            container.insertBefore(tab, target);
            follow(); // realign the translation to the new slot
          }
        };
        const onUp = () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onUp);
          if (!dragged) return;
          tab.classList.remove("dragging");
          tab.style.transform = "";
          const next = tab.nextElementSibling as HTMLElement | null;
          h.reorder!(t.id, next?.dataset.id ?? null);
          // the flag resets after the synthetic click that follows release
          window.setTimeout(() => (dragged = false), 0);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
      });
    }
    if (t.fixed) tab.classList.add("tab-fixed");
    container.appendChild(tab);
  }
}
