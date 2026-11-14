import {
  SESSION_NAME_DISPLAY_NOTE,
  sessionNameDisplayInstruction,
  sessionNameDisplayReminder,
} from "../../session-name-display.ts";
import { NAME_BLOCK_SURFACE_ID, type SessionTitleSurface } from "../types.ts";

/**
 * The portable default (ADR 0085): the agent prints the copyable name block
 * and a person copies it into the client. It matches every session, so it is
 * the registry's final fallback and the target when a writing surface fails.
 * Its wording is the existing display protocol, unchanged.
 */
export const nameBlockSurface: SessionTitleSurface = {
  id: NAME_BLOCK_SURFACE_ID,
  delivery: "display",
  detect: () => true,
  instruction: (title) => sessionNameDisplayInstruction(title),
  reminder: (title) => sessionNameDisplayReminder(title),
  note: SESSION_NAME_DISPLAY_NOTE,
};
