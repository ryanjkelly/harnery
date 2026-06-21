"use client";

/**
 * Cross-component trigger for the CouncilActions dialogs. The next-action
 * banner (an RSC) wants its "Advance to round N" / "Close the council" text
 * to actually open the matching confirmation, not just anchor-scroll to the
 * Actions panel, but the dialog state lives inside the CouncilActions client
 * component. This pair bridges them with a window CustomEvent, keeping the
 * components decoupled.
 */

export const COUNCIL_ACTION_EVENT = "harnery:council-action";

export type CouncilActionDetail = { action: "advance" | "close" };

export function dispatchCouncilAction(detail: CouncilActionDetail): void {
  window.dispatchEvent(new CustomEvent(COUNCIL_ACTION_EVENT, { detail }));
}

/** Styled like an inline link; clicking opens the matching dialog directly. */
function CouncilActionTrigger({
  action,
  className,
  children,
}: {
  action: CouncilActionDetail["action"];
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => dispatchCouncilAction({ action })}
      className={className}
    >
      {children}
    </button>
  );
}

export function AdvanceCouncilTrigger(props: {
  className?: string;
  children: React.ReactNode;
}) {
  return <CouncilActionTrigger action="advance" {...props} />;
}

export function CloseCouncilTrigger(props: {
  className?: string;
  children: React.ReactNode;
}) {
  return <CouncilActionTrigger action="close" {...props} />;
}
