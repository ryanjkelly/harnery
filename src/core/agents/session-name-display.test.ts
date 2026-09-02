import { describe, expect, test } from "bun:test";
import {
  assistantTextStartsWithSessionNameBlock,
  isSessionNameRemediationCommand,
  matchSessionNameDisplay,
  sessionNameDisplayAcceptedNames,
  sessionNameDisplayBlock,
  sessionNameDisplayPending,
  sessionNameDisplayRecoveryInstruction,
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

  test("tolerates any single-word fence label and a longer matching fence", () => {
    for (const label of ["txt", "markdown", "plaintext", "text", "md"]) {
      expect(assistantTextStartsWithSessionNameBlock(`\`\`\`${label}\n${NAME}\n\`\`\``, NAME)).toBe(
        true,
      );
    }
    expect(
      assistantTextStartsWithSessionNameBlock(`\`\`\`\`\n${NAME}\n\`\`\`\`\nNext.`, NAME),
    ).toBe(true);
  });

  test("still requires a closing fence as long as the opening run", () => {
    expect(assistantTextStartsWithSessionNameBlock(`\`\`\`\`\n${NAME}\n\`\`\`\nNext.`, NAME)).toBe(
      false,
    );
  });

  test("accepts the title the agent was told to show when the suggestion drifted", () => {
    const asked = "Agent Maya - Auth refactor";
    const row = {
      suggested_session_name: "Agent Maya - Session naming",
      session_name_display_requested_for: asked,
    };
    expect(sessionNameDisplayAcceptedNames(row)).toEqual(["Agent Maya - Session naming", asked]);
    expect(matchSessionNameDisplay(row, sessionNameDisplayBlock(asked))).toEqual({
      pending: "Agent Maya - Session naming",
      displayed: asked,
    });
    // A satisfied latch accepts nothing further, drift record or not.
    expect(
      sessionNameDisplayAcceptedNames({
        ...row,
        session_name_seen_for: row.suggested_session_name,
      }),
    ).toEqual([]);
  });

  test("never accepts a title that was neither pending nor requested", () => {
    const row = {
      suggested_session_name: NAME,
      session_name_display_requested_for: NAME,
    };
    expect(
      matchSessionNameDisplay(row, sessionNameDisplayBlock("Agent Maya - Something else")),
    ).toBeNull();
    expect(
      matchSessionNameDisplay(row, `Starting.\n\n${sessionNameDisplayBlock(NAME)}`),
    ).toBeNull();
    expect(matchSessionNameDisplay(row, undefined)).toBeNull();
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

  test("exempts only single set-task, status, and suggest-name remediation commands", () => {
    expect(isSessionNameRemediationCommand('harn agents set-task "Fix naming"', "harn")).toBe(true);
    expect(isSessionNameRemediationCommand("harn agents status --end-turn", "harn")).toBe(true);
    expect(isSessionNameRemediationCommand("harn agents suggest-name --json", "harn")).toBe(true);
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

  test("names the exact explicit recovery command after a rejected display", () => {
    const instruction = sessionNameDisplayRecoveryInstruction(NAME, "acme");
    expect(instruction).toContain(sessionNameDisplayBlock(NAME));
    expect(instruction).toContain("`acme agents suggest-name --json`");
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

  test("recognizes only start, done, and retry mint responses for the current name", () => {
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
    expect(
      toolResponseMintedSessionName(
        {
          suggested_session_name: NAME,
          first_of_session: false,
          session_name_retry: true,
        },
        NAME,
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

  test("recognizes a mint whose JSON the shell cut short", () => {
    const full = JSON.stringify({
      name: "agent-Maya",
      suggested_session_name: NAME,
      session_name_retry: true,
      agent_name: "Maya",
      description: "Auth refactor",
    });
    // `| cut -c1-120` style truncation: the closing brace never arrives.
    const cut = full.slice(0, full.indexOf('"agent_name"') + 20);
    expect(JSON.parse.bind(null, cut)).toThrow();
    expect(toolResponseMintedSessionName(cut, NAME)).toBe(true);
    // A tail window that lost the opening brace still carries name and flag.
    expect(toolResponseMintedSessionName(full.slice(8), NAME)).toBe(true);
    // Wrapper prose around the cut JSON is fine too.
    expect(toolResponseMintedSessionName({ output: `Output:\n${cut}` }, NAME)).toBe(true);
  });

  test("truncated output without the flag or with another name never mints", () => {
    const noFlag = JSON.stringify({ suggested_session_name: NAME, cleared: false }).slice(0, -1);
    expect(toolResponseMintedSessionName(noFlag, NAME)).toBe(false);
    const flagLost = JSON.stringify({
      suggested_session_name: NAME,
      session_name_retry: true,
    }).slice(0, -12);
    expect(toolResponseMintedSessionName(flagLost, NAME)).toBe(false);
    const otherName = JSON.stringify({
      suggested_session_name: "Agent Maya - Earlier focus",
      first_of_session: true,
    }).slice(0, -1);
    expect(toolResponseMintedSessionName(otherName, NAME)).toBe(false);
    // A name that merely starts the same must not match by prefix.
    const longer = JSON.stringify({
      suggested_session_name: `${NAME} again`,
      first_of_session: true,
    }).slice(0, -1);
    expect(toolResponseMintedSessionName(longer, NAME)).toBe(false);
  });
});
