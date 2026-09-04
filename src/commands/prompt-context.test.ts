import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import {
  PROMPT_CONTEXT_SESSION_KEY_ENV,
  stageCursorPromptContext,
  startCursorPromptContextSession,
} from "../core/hooks/prompt-context/state.ts";
import { registerPromptContextCommand } from "./prompt-context.ts";

const roots: string[] = [];
const originalKey = process.env[PROMPT_CONTEXT_SESSION_KEY_ENV];

afterEach(() => {
  if (originalKey === undefined) delete process.env[PROMPT_CONTEXT_SESSION_KEY_ENV];
  else process.env[PROMPT_CONTEXT_SESSION_KEY_ENV] = originalKey;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prompt-context consume command", () => {
  test("prints staged context as text and consumes it once", async () => {
    const fixture = setup("prefetched facts");
    process.env[PROMPT_CONTEXT_SESSION_KEY_ENV] = fixture.sessionKey;

    const first = capture();
    await program(first.emit, fixture.root).parseAsync(["prompt-context", "consume"], {
      from: "user",
    });
    expect(first.text).toEqual(["prefetched facts"]);
    expect(first.errors).toEqual([]);

    const second = capture();
    await program(second.emit, fixture.root).parseAsync(["prompt-context", "consume"], {
      from: "user",
    });
    expect(second.text).toEqual([]);
    expect(second.data).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.exits).toEqual([]);
  });

  test("emits a stable JSON envelope and reports empty as success", async () => {
    const fixture = setup("prefetched facts");
    process.env[PROMPT_CONTEXT_SESSION_KEY_ENV] = fixture.sessionKey;

    const first = capture();
    await program(first.emit, fixture.root).parseAsync(["prompt-context", "consume", "--json"], {
      from: "user",
    });
    expect(first.formats).toEqual(["json"]);
    expect(first.data[0]).toMatchObject({
      schema: "harnery.prompt-context-consume/v1",
      status: "consumed",
      context: "prefetched facts",
    });

    const second = capture();
    await program(second.emit, fixture.root).parseAsync(["prompt-context", "consume", "--json"], {
      from: "user",
    });
    expect(second.data).toEqual([{ schema: "harnery.prompt-context-consume/v1", status: "empty" }]);
    expect(second.errors).toEqual([]);
    expect(second.exits).toEqual([]);
  });

  test("fails clearly when the inherited session key is missing", async () => {
    const root = makeRoot();
    delete process.env[PROMPT_CONTEXT_SESSION_KEY_ENV];
    const output = capture();
    await program(output.emit, root).parseAsync(["prompt-context", "consume"], { from: "user" });
    expect(output.errors).toEqual([
      {
        code: "prompt_context_consume_failed",
        message: `${PROMPT_CONTEXT_SESSION_KEY_ENV} is not set for this Cursor session`,
      },
    ]);
    expect(output.exits).toEqual([1]);
  });

  test("is registered through createHarneryProgram for embedding CLIs", async () => {
    const fixture = setup("from lazy command");
    process.env[PROMPT_CONTEXT_SESSION_KEY_ENV] = fixture.sessionKey;
    const output = capture();
    const command = createHarneryProgram({
      binName: "acme",
      emit: output.emit,
      context: { resolveCoordRoot: () => fixture.root },
    });

    await command.parseAsync(["prompt-context", "consume", "--json"], { from: "user" });
    expect(output.data[0]).toMatchObject({
      schema: "harnery.prompt-context-consume/v1",
      status: "consumed",
      context: "from lazy command",
    });
  });
});

function setup(context: string): { root: string; sessionKey: string } {
  const root = makeRoot();
  const session = startCursorPromptContextSession({
    coordRoot: root,
    conversationId: "conversation-1",
  });
  stageCursorPromptContext({
    coordRoot: root,
    conversationId: "conversation-1",
    turnId: "turn-1",
    context,
  });
  return { root, sessionKey: session.sessionKey };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-prompt-context-command-"));
  roots.push(root);
  return root;
}

function program(emit: EmitContext, root: string): Command {
  const command = new Command();
  registerPromptContextCommand(command, emit, { resolveCoordRoot: () => root });
  return command;
}

function capture(): {
  emit: EmitContext;
  formats: string[];
  data: unknown[];
  text: string[];
  errors: unknown[];
  exits: number[];
} {
  const formats: string[] = [];
  const data: unknown[] = [];
  const text: string[] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  return {
    emit: {
      config: ({ format }) => {
        if (format) formats.push(format);
      },
      data: (value) => data.push(value),
      rows: () => {},
      text: (value) => text.push(value),
      file: () => {},
      error: (value) => errors.push(value),
      log: () => {},
      setExitCode: (value) => exits.push(value),
    },
    formats,
    data,
    text,
    errors,
    exits,
  };
}
