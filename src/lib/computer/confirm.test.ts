import { describe, expect, test } from "bun:test";
import {
  encodePowerShell,
  interpretDialog,
  macDialogScript,
  windowsDialogScript,
} from "./confirm.ts";

const run = (status: number | null, stdout = "", timedOut = false) => ({
  status,
  stdout,
  timedOut,
});

describe("approval dialogs", () => {
  test("Windows: only an explicit Yes approves", () => {
    expect(interpretDialog("windows", run(0, "6\r\n"))).toBe("approved");
    expect(interpretDialog("windows", run(0, "7\r\n"))).toBe("denied");
    expect(interpretDialog("windows", run(0, "-1\r\n"))).toBe("timed-out");
    expect(interpretDialog("windows", run(1, ""))).toBe("denied");
    expect(interpretDialog("windows", run(null, "", true))).toBe("timed-out");
  });

  test("macOS: Allow approves, Deny and giving up do not", () => {
    expect(interpretDialog("mac", run(0, "button returned:Allow, gave up:false"))).toBe("approved");
    expect(interpretDialog("mac", run(1, ""))).toBe("denied");
    expect(interpretDialog("mac", run(0, "button returned:, gave up:true"))).toBe("timed-out");
  });

  test("zenity: exit 0 approves, 5 is a timeout, anything else denies", () => {
    expect(interpretDialog("zenity", run(0))).toBe("approved");
    expect(interpretDialog("zenity", run(5))).toBe("timed-out");
    expect(interpretDialog("zenity", run(1))).toBe("denied");
  });

  test("the dialogs default to the refusing button", () => {
    const script = windowsDialogScript("Allow it?", 'Purpose: it\'s "quoted" & long', 90);
    // Yes/No, warning, No as default, always on top, with its own 90-second timer.
    expect(script).toContain(".Popup($text, 90, $title, 4 + 48 + 256 + 4096)");
    // The text travels as base64, so quotes in it cannot break the script.
    expect(script).not.toContain('"quoted"');
    expect(script).toContain(Buffer.from("Allow it?", "utf8").toString("base64"));
    expect(Buffer.from(encodePowerShell(script), "base64").toString("utf16le")).toBe(script);
    expect(macDialogScript(90)).toContain('default button "Deny"');
    expect(macDialogScript(90)).toContain("giving up after 90");
  });
});
