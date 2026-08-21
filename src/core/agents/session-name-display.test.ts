import { describe, expect, test } from "bun:test";
import {
  assistantTextStartsWithSessionNameBlock,
  isSessionNameRemediationCommand,
  sessionNameDisplayBlock,
  sessionNameDisplayPending,
  toolResponseMintedSessionName,
} from "./session-name-display.ts";

const NAME = "Agent Maya - Auth refactor";

describe("session name display latch", () => {
  test("is pending until the sighting covers the current suggestion", () => {
    expect(sessionNameDisplayPending({})).toBeNull();
    expect(sessionNameDisplayPending({ suggested_session_name: NAME })).toBe(NAME);
    expect(
      sessionNameDisplayPending({
        suggested_session_name: NAME,
        session_name_seen_for: "Agent Maya - Earlier focus",
      }),
    ).toBe(NAME);
    expect(
      sessionNameDisplayPending({
        suggested_session_name: NAME,
        session_name_seen_for: NAME,
      }),
    ).toBeNull();
  });

  test("accepts the exact block as the first non-whitespace content", () => {
    expect(assistantTextStartsWithSessionNameBlock(sessionNameDisplayBlock(NAME), NAME)).toBe(true);
    expect(
      assistantTextStartsWithSessionNameBlock(`\n  \`\`\`text\n${NAME}\n\`\`\`\nContinuing.`, NAME),
    ).toBe(true);
  });

  test("rejects prose mentions, leading commentary, and extra block content", () => {
    expect(assistantTextStartsWithSessionNameBlock(NAME, NAME)).toBe(false);
    expect(
      assistantTextStartsWithSessionNameBlock(
        `Starting now.\n\n${sessionNameDisplayBlock(NAME)}`,
        NAME,
      ),
    ).toBe(false);
    expect(assistantTextStartsWithSessionNameBlock(`\`\`\`\n${NAME}\nextra\n\`\`\``, NAME)).toBe(
      false,
    );
  });

  test("exempts only single set-task and status remediation commands", () => {
    expect(isSessionNameRemediationCommand('harn agents set-task "Fix naming"', "harn")).toBe(true);
    expect(isSessionNameRemediationCommand("harn agents status --end-turn", "harn")).toBe(true);
    expect(
      isSessionNameRemediationCommand(
        "# intent: Close the turn.\ncodex-wsl -- acme agents status --end-turn",
        "acme",
      ),
    ).toBe(true);
    expect(isSessionNameRemediationCommand("harn agents lifecycle done", "harn")).toBe(false);
    expect(isSessionNameRemediationCommand("harn agents status && echo bypass", "harn")).toBe(
      false,
    );
    expect(isSessionNameRemediationCommand('harn agents set-task "$(echo bypass)"', "harn")).toBe(
      false,
    );
  });

  test("tolerates trailing stream redirects on remediation commands", () => {
    // A latched session cannot close its turn if `2>&1` disables the exemption,
    // because the end-of-turn rule requires the very command the latch blocks.
    expect(isSessionNameRemediationCommand("harn agents status --end-turn 2>&1", "harn")).toBe(
      true,
    );
    expect(isSessionNameRemediationCommand('harn agents set-task "Fix naming" 2>&1', "harn")).toBe(
      true,
    );
    expect(
      isSessionNameRemediationCommand("harn agents status --end-turn 2>/dev/null", "harn"),
    ).toBe(true);
    expect(
      isSessionNameRemediationCommand("harn agents status --end-turn >/dev/null 2>&1", "harn"),
    ).toBe(true);
    expect(
      isSessionNameRemediationCommand(
        "# intent: Close the turn.\nharn agents status --end-turn 2>&1",
        "harn",
      ),
    ).toBe(true);

    // Redirecting to a named file, or chaining past a redirect, stays rejected.
    expect(isSessionNameRemediationCommand("harn agents status > /tmp/out", "harn")).toBe(false);
    expect(isSessionNameRemediationCommand("harn agents status 2>&1 && echo bypass", "harn")).toBe(
      false,
    );
    expect(isSessionNameRemediationCommand("harn agents status 2>&1 | tee /tmp/out", "harn")).toBe(
      false,
    );
  });

  test("recognizes only start and done mint responses for the current name", () => {
    expect(
      toolResponseMintedSessionName({ suggested_session_name: NAME, first_of_session: true }, NAME),
    ).toBe(true);
    expect(
      toolResponseMintedSessionName(
        {
          output: `Script completed\nOutput:\n${JSON.stringify({
            suggested_session_name: `[DONE] ${NAME}`,
            name_reminted: true,
          })}`,
        },
        `[DONE] ${NAME}`,
      ),
    ).toBe(true);
    expect(toolResponseMintedSessionName({ suggested_session_name: NAME }, NAME)).toBe(false);
    expect(
      toolResponseMintedSessionName(
        { suggested_session_name: NAME, first_of_session: false, name_reminted: false },
        NAME,
      ),
    ).toBe(false);
    expect(
      toolResponseMintedSessionName(
        { suggested_session_name: "Agent Maya - Earlier focus", first_of_session: true },
        NAME,
      ),
    ).toBe(false);
  });
});
