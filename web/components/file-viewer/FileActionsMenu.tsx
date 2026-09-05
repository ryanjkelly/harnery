"use client";

import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface FileAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

interface FileActionsMenuProps {
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  actions: FileAction[];
  label: string;
  /** The row or ellipsis button that opened this menu. Defaults to the element
   * focused when the menu mounts; disconnected elements are never focused. */
  returnFocus?: HTMLElement | null;
}

/** Shared by row context menus and visible action buttons. The caller owns
 * the trigger and its aria-haspopup/aria-expanded state. */
export function FileActionsMenu(props: FileActionsMenuProps) {
  if (!props.anchor || typeof document === "undefined") return null;
  return (
    <OpenFileActionsMenu
      key={`${props.anchor.x}:${props.anchor.y}:${props.label}`}
      {...props}
      anchor={props.anchor}
    />
  );
}

function OpenFileActionsMenu({
  anchor,
  actions,
  label,
  onClose,
  returnFocus,
}: Omit<FileActionsMenuProps, "anchor"> & { anchor: { x: number; y: number } }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const originRef = useRef<HTMLElement | null>(null);
  const dismissedRef = useRef(false);
  const [position, setPosition] = useState(anchor);

  const restoreFocus = () => {
    const origin = originRef.current;
    if (origin?.isConnected) origin.focus({ preventScroll: true });
  };
  const dismiss = (restore: boolean) => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    // Restore before calling an action: an action may open a dialog or move
    // focus elsewhere, and this menu must not steal it back afterward.
    if (restore) restoreFocus();
    closeRef.current();
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const reposition = () => {
      const bounds = menu.getBoundingClientRect();
      setPosition({
        x: Math.max(8, Math.min(anchor.x, window.innerWidth - bounds.width - 8)),
        y: Math.max(8, Math.min(anchor.y, window.innerHeight - bounds.height - 8)),
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [anchor.x, anchor.y]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    originRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    (menu.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? menu).focus(
      { preventScroll: true },
    );

    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) {
        dismissedRef.current = true;
        closeRef.current();
      }
    };
    const outsideScroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", outsidePointer, true);
    window.addEventListener("scroll", outsideScroll, true);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      window.removeEventListener("scroll", outsideScroll, true);
      // An external state change may also remove the menu. Restore only while
      // focus still belongs to it, never after a click focuses another control.
      const focused = document.activeElement;
      if (
        !dismissedRef.current &&
        (focused === document.body || (focused && menu.contains(focused))) &&
        originRef.current?.isConnected
      ) {
        originRef.current.focus({ preventScroll: true });
      }
    };
  }, [returnFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keep Browse's file-navigation shortcuts from running behind the menu.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss(true);
      return;
    }
    if (event.key === "Tab") {
      // Native Tab continues from the invoking control, not the portal at the
      // end of the document. Shift+Tab follows the same browser behavior.
      dismiss(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current < 0 ? items.length - 1 : current - 1 + items.length) % items.length;
    items[next].focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ position: "fixed", left: position.x, top: position.y, zIndex: 100 }}
      className="w-60 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none"
    >
      <div
        aria-hidden="true"
        className="truncate border-b border-border px-2 py-2 text-xs text-muted-foreground"
      >
        {label}
      </div>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={action.disabled}
          onClick={(event) => {
            event.stopPropagation();
            dismiss(true);
            action.onSelect();
          }}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:pointer-events-none disabled:opacity-40"
        >
          {action.icon && (
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
              {action.icon}
            </span>
          )}
          <span className="min-w-0 flex-1">{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
