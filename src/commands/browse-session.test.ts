import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createHarneryProgram } from "../commander.ts";
import { parseLocatorOptions, readFillValue } from "./browse-session.ts";

describe("browse-session command", () => {
  test("registers the complete version-1 command surface", () => {
    const program = createHarneryProgram();
    const session = program.commands.find((command) => command.name() === "browse-session");
    expect(session).toBeDefined();
    expect(session?.commands.map((command) => command.name())).toEqual([
      "status",
      "inspect",
      "screenshot",
      "tabs",
      "select-tab",
      "open-tab",
      "close-tab",
      "goto",
      "reload",
      "click",
      "fill",
      "press",
      "wait",
      "close",
    ]);
    expect(session?.commands.every((command) => command.description().trim().length > 0)).toBe(
      true,
    );
    expect(program.commands.find((command) => command.name() === "browse")?.options).toContainEqual(
      expect.objectContaining({ long: "--control-file" }),
    );
  }, 10_000);

  test("requires exactly one locator form and keeps exact matching as the default", () => {
    expect(parseLocatorOptions({ controlFile: "x", label: "Email" }, true)).toEqual({
      kind: "label",
      value: "Email",
      partial: false,
    });
    expect(
      parseLocatorOptions(
        { controlFile: "x", role: "button", name: "Continue", partial: true },
        true,
      ),
    ).toEqual({ kind: "role", value: "button", name: "Continue", partial: true });
    expect(() =>
      parseLocatorOptions({ controlFile: "x", selector: "button", text: "Continue" }, true),
    ).toThrow("Choose exactly one locator");
    expect(() =>
      parseLocatorOptions({ controlFile: "x", selector: "button", partial: true }, true),
    ).toThrow("--partial is not valid with --selector");
    expect(parseLocatorOptions({ controlFile: "x" }, false)).toBeUndefined();
  });

  test("reads fill input once, removes one pipeline newline, and enforces the byte cap", async () => {
    expect(await readFillValue(Readable.from([Buffer.from("secret-value\n")]))).toBe(
      "secret-value",
    );
    expect(await readFillValue(Readable.from([Buffer.from("line-one\nline-two\n")]))).toBe(
      "line-one\nline-two",
    );
    await expect(
      readFillValue(Readable.from([Buffer.alloc(64 * 1024 + 1, 65)])),
    ).rejects.toMatchObject({ code: "fill_too_large" });
  });
});
