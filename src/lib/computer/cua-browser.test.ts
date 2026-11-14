import { describe, expect, test } from "bun:test";
import { createCuaDriver } from "./cua.ts";
import {
  checkBrowserUrl,
  cuaBrowserCalls,
  cuaBrowserObservation,
  cuaLaunchedProcess,
  defaultBrowserPattern,
  PASSWORD_OFFER_PATTERN,
  parseWindowList,
  pickBrowser,
  pickFrontBrowser,
  SENSITIVE_FIELD_PATTERN,
  windowFrameArgs,
} from "./cua-browser.ts";
import type { BrowserCall } from "./types.ts";

describe("cuaBrowserCalls", () => {
  test("classifies each browser tool", () => {
    const table: [string, Record<string, unknown>, BrowserCall[]][] = [
      [
        "browser_prepare",
        { pid: 1, window_id: 2, session: "s", strategy: { kind: "existing_profile" } },
        [{ kind: "attach", tool: "browser_prepare", session: "s", pid: 1, window_id: 2 }],
      ],
      [
        "browser_prepare",
        { allow_launch: true, profile: { mode: "isolated_new" } },
        [{ kind: "launch", tool: "browser_prepare" }],
      ],
      [
        "get_browser_state",
        { pid: 1, window_id: 2, session: "s" },
        [{ kind: "bind", tool: "get_browser_state", session: "s", pid: 1, window_id: 2 }],
      ],
      [
        "get_browser_state",
        { target_id: "bt-1", tab_id: "tab-1", session: "s" },
        [
          {
            kind: "read",
            tool: "get_browser_state",
            session: "s",
            target_id: "bt-1",
            tab_id: "tab-1",
          },
        ],
      ],
      [
        "browser_type",
        { target_id: "bt-1", tab_id: "tab-1", ref: "p7:0", text: "x" },
        [{ kind: "type", tool: "browser_type", target_id: "bt-1", tab_id: "tab-1", ref: "p7:0" }],
      ],
      [
        "browser_click",
        { target_id: "bt-1", tab_id: "tab-1", ref: "p1:2" },
        [{ kind: "point", tool: "browser_click", target_id: "bt-1", tab_id: "tab-1", ref: "p1:2" }],
      ],
      [
        "browser_pointer",
        { target_id: "bt-1" },
        [{ kind: "point", tool: "browser_pointer", target_id: "bt-1" }],
      ],
      [
        "browser_navigate",
        { target_id: "bt-1", tab_id: "tab-1", url: "https://x" },
        [
          {
            kind: "act",
            tool: "browser_navigate",
            target_id: "bt-1",
            tab_id: "tab-1",
            navigates: true,
          },
        ],
      ],
      [
        "browser_select",
        { target_id: "bt-1" },
        [{ kind: "act", tool: "browser_select", target_id: "bt-1" }],
      ],
      ["browser_dialog", {}, [{ kind: "act", tool: "browser_dialog" }]],
      ["browser_download", {}, [{ kind: "act", tool: "browser_download" }]],
      ["browser_set_input_files", {}, [{ kind: "act", tool: "browser_set_input_files" }]],
      ["page", { session: "s" }, [{ kind: "opaque", tool: "page", session: "s" }]],
      ["click", { pid: 1 }, []],
      ["run_script", { script: "await click({pid:1})" }, []],
      [
        "run_script",
        { script: "await browser_click({ref:'p1:1'})", session: "s" },
        [{ kind: "opaque", tool: "run_script", session: "s" }],
      ],
    ];
    for (const [tool, args, expected] of table)
      expect(cuaBrowserCalls(tool, args)).toEqual(expected);
  });

  test("run_steps flattens both step forms and inherits the outer session", () => {
    expect(
      cuaBrowserCalls("run_steps", {
        session: "outer",
        steps: [
          { tool: "browser_type", args: { target_id: "bt-1", tab_id: "t", ref: "p1:0" } },
          { browser_click: { target_id: "bt-1", ref: "p1:1", session: "inner" } },
          { tool: "click", args: { pid: 1 } },
          "junk",
        ],
      }),
    ).toEqual([
      {
        kind: "type",
        tool: "browser_type",
        session: "outer",
        target_id: "bt-1",
        tab_id: "t",
        ref: "p1:0",
      },
      { kind: "point", tool: "browser_click", session: "inner", target_id: "bt-1", ref: "p1:1" },
    ]);
    expect(cuaBrowserCalls("run_steps", {})).toEqual([]);
  });

  test("the driver exposes the classifier and observation", () => {
    const driver = createCuaDriver();
    expect(driver.browserCalls?.("page", {})).toEqual([{ kind: "opaque", tool: "page" }]);
    expect(driver.browserObservation?.({ kind: "act", tool: "x" }, '{"status":"ok"}')).toEqual({
      delivered: true,
    });
  });
});

describe("cuaBrowserObservation", () => {
  const bind: BrowserCall = {
    kind: "bind",
    tool: "get_browser_state",
    pid: 30536,
    window_id: 67656,
  };
  const read: BrowserCall = { kind: "read", tool: "get_browser_state", target_id: "bt-1" };

  test("non-JSON shows nothing", () => {
    expect(cuaBrowserObservation(bind, "oops")).toEqual({});
    expect(cuaBrowserObservation(bind, "[1]")).toEqual({});
  });

  test("a successful bind names the target for the window", () => {
    const stdout = JSON.stringify({
      binding_quality: "exact",
      mode: "bind",
      status: "ok",
      tabs: [{ active: true, tab_id: "tab-1", title: "T", url: "https://x" }],
      target_id: "bt-9",
    });
    expect(cuaBrowserObservation(bind, stdout)).toEqual({
      bound: { target_id: "bt-9", pid: 30536, window_id: 67656 },
    });
  });

  test("a refusal shows nothing for a bind and no delivery for an action", () => {
    const refused = JSON.stringify({
      status: "refused",
      refusal: { code: "browser_consent_required" },
    });
    expect(cuaBrowserObservation(bind, refused)).toEqual({});
    expect(cuaBrowserObservation({ kind: "type", tool: "browser_type" }, refused)).toEqual({
      delivered: false,
    });
    const stale = JSON.stringify({ code: "browser_ref_stale", message: "stale" });
    expect(cuaBrowserObservation({ kind: "point", tool: "browser_click" }, stale)).toEqual({
      delivered: false,
    });
  });

  test("a launch reports the prepared pid; an attach does not count as a launch", () => {
    const stdout = JSON.stringify({
      action: "attached_existing_profile",
      prepared: true,
      prepared_pid: 30536,
      status: "ok",
    });
    expect(cuaBrowserObservation({ kind: "launch", tool: "browser_prepare" }, stdout)).toEqual({
      launched_pid: 30536,
    });
    expect(cuaBrowserObservation({ kind: "attach", tool: "browser_prepare" }, stdout)).toEqual({});
  });

  test("a semantic_v2 snapshot flags the password field by name and a 1Password offer in the outline", () => {
    const stdout = JSON.stringify({
      tab_id: "tab-1",
      target_id: "bt-1",
      refs: [
        {
          actions: ["type", "pointer"],
          name: "Email",
          ref: "p7:1",
          role: "textbox",
          states: { editable: "plaintext" },
        },
        {
          actions: ["type", "pointer"],
          name: "Password",
          ref: "p7:0",
          role: "textbox",
          states: { editable: "plaintext" },
        },
        { actions: ["pointer"], name: "Forgot password?", ref: "p7:2", role: "link" },
      ],
      content_refs: [
        { actions: ["type"], name: "Verification code", ref: "p7:3", role: "textbox" },
      ],
      outline:
        '- menu "Items" [focused=true]\n  - menuitem "Save in 1Password"\n    - button "Save in 1Password"',
    });
    expect(cuaBrowserObservation(read, stdout)).toEqual({
      snapshot: {
        target_id: "bt-1",
        tab_id: "tab-1",
        sensitive_refs: ["p7:0", "p7:3"],
        password_offer: true,
      },
    });
  });

  test("a dom_refs_v1 snapshot flags type=password and one-time-code inputs", () => {
    const stdout = JSON.stringify({
      snapshot_id: "s1",
      tab_id: "tab-2",
      target_id: "bt-2",
      url: "https://x/login",
      refs: [
        {
          frame: "main",
          label: "placeholder=Enter your password id=password type=password",
          node: "input",
          ref: "p8:46",
        },
        { frame: "main", label: "id=code autocomplete=one-time-code", node: "input", ref: "p8:47" },
        { frame: "main", label: "id=user type=email", node: "input", ref: "p8:45" },
        {
          frame: "main",
          label: "id=show type=checkbox Show password",
          node: "input",
          ref: "p8:48",
        },
        { frame: "main", label: "Sign in", node: "button", ref: "p8:49" },
      ],
    });
    expect(cuaBrowserObservation(read, stdout)).toEqual({
      snapshot: {
        target_id: "bt-2",
        tab_id: "tab-2",
        sensitive_refs: ["p8:46", "p8:47"],
        password_offer: false,
      },
    });
  });

  test("delivery for type, point and navigate results", () => {
    const typed = JSON.stringify({
      delivery: { delivered_count: 21, mode: "background" },
      effect: "unverifiable",
      route: "trusted_input",
      summary: "typed 21 char(s) into tab-1",
    });
    expect(cuaBrowserObservation({ kind: "type", tool: "browser_type" }, typed)).toEqual({
      delivered: true,
    });
    const navigated = JSON.stringify({
      refs_invalidated: true,
      status: "ok",
      tab_id: "t",
      target_id: "b",
      url: "u",
    });
    expect(
      cuaBrowserObservation({ kind: "act", tool: "browser_navigate", navigates: true }, navigated),
    ).toEqual({
      delivered: true,
    });
    expect(cuaBrowserObservation({ kind: "point", tool: "browser_click" }, "{}")).toEqual({
      delivered: false,
    });
  });

  test("the exported patterns", () => {
    for (const text of [
      "Password",
      "Passcode",
      "passphrase",
      "Enter PIN",
      "One-time code",
      "OTP",
      "2FA code",
      "Security code",
      "verification code",
    ])
      expect(SENSITIVE_FIELD_PATTERN.test(text)).toBe(true);
    for (const text of ["Email", "Username", "Spinner", "Pinned items"])
      expect(SENSITIVE_FIELD_PATTERN.test(text)).toBe(false);
    for (const text of [
      "Save in 1Password",
      "Bitwarden",
      "LastPass",
      "Proton Pass",
      "Save password?",
      "Use a strong password",
      "Update password",
    ])
      expect(PASSWORD_OFFER_PATTERN.test(text)).toBe(true);
    for (const text of ["Password", "Forgot password?", "Bookkeeper"])
      expect(PASSWORD_OFFER_PATTERN.test(text)).toBe(false);
  });
});

describe("window helpers", () => {
  test("parseWindowList reads the object and bare-array forms", () => {
    const row = { app_name: "chrome.exe", pid: 1, title: "t", window_id: 2, z_index: 3 };
    expect(parseWindowList(JSON.stringify({ windows: [row] }))).toEqual([
      { pid: 1, window_id: 2, app_name: "chrome.exe", z_index: 3 },
    ]);
    expect(parseWindowList(JSON.stringify([{ ...row, z_index: null }, { pid: "x" }]))).toEqual([
      { pid: 1, window_id: 2, app_name: "chrome.exe", z_index: null },
    ]);
    expect(parseWindowList("nope")).toEqual([]);
  });

  test("pickBrowser prefers the default browser over the front-most one", () => {
    const w = (pid: number, app_name: string, z_index: number | null) => ({
      pid,
      window_id: pid * 10,
      app_name,
      z_index,
    });
    const windows = [w(1, "chrome.exe", 2), w(2, "brave.exe", 9), w(1, "chrome.exe", 4)];
    expect(pickBrowser(windows, defaultBrowserPattern("ChromeHTML"))).toBe(1);
    expect(pickBrowser(windows, defaultBrowserPattern("brave-browser.desktop"))).toBe(2);
    // The default browser is not running, or is not a supported one: fall back to the front-most.
    expect(pickBrowser(windows, defaultBrowserPattern("MSEdgeHTM"))).toBe(2);
    expect(defaultBrowserPattern("FirefoxURL-308046B0AF4A39CB")).toBeUndefined();
    expect(pickBrowser(windows, undefined)).toBe(2);
  });

  test("pickFrontBrowser takes the highest z_index among supported browsers", () => {
    const w = (pid: number, app_name: string, z_index: number | null) => ({
      pid,
      window_id: pid * 10,
      app_name,
      z_index,
    });
    expect(
      pickFrontBrowser([w(1, "chrome.exe", 2), w(2, "Microsoft Edge", 5), w(3, "Code.exe", 9)]),
    ).toBe(2);
    expect(pickFrontBrowser([w(4, "Brave Browser", null), w(4, "Brave Browser", null)])).toBe(4);
    expect(() => pickFrontBrowser([w(3, "firefox.exe", 9)])).toThrow(
      /No window of a supported browser/,
    );
  });

  test("checkBrowserUrl defaults to about:blank", () => {
    expect(checkBrowserUrl(undefined)).toBe("about:blank");
    expect(checkBrowserUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(() => checkBrowserUrl("chrome://settings")).toThrow(/Refusing/);
  });
});

describe("window frame helpers", () => {
  test("parseWindowList carries bounds or top-level frame fields", () => {
    const bounds = { x: 9700, y: 1500, width: 627, height: 180 };
    expect(
      parseWindowList(JSON.stringify({ windows: [{ pid: 1, window_id: 2, bounds }] }))[0]?.frame,
    ).toEqual(bounds);
    expect(
      parseWindowList(JSON.stringify([{ pid: 1, window_id: 2, ...bounds }]))[0]?.frame,
    ).toEqual(bounds);
    expect(
      parseWindowList(JSON.stringify([{ pid: 1, window_id: 2, x: 1, y: 2, width: 3 }]))[0],
    ).not.toHaveProperty("frame");
  });

  test("windowFrameArgs merges, rounds and validates", () => {
    const current = { x: 1, y: 2, width: 300, height: 200 };
    expect(windowFrameArgs({ pid: 5, window_id: 6 }, current, { y: 9.4 })).toEqual({
      pid: 5,
      window_id: 6,
      x: 1,
      y: 9,
      width: 300,
      height: 200,
    });
    expect(() => windowFrameArgs({ pid: 0, window_id: 6 }, current, {})).toThrow(/integer/);
    expect(() => windowFrameArgs({ pid: 5, window_id: 6 }, current, { x: Infinity })).toThrow(
      /finite/,
    );
    expect(() => windowFrameArgs({ pid: 5, window_id: 6 }, current, { width: 0 })).toThrow(
      /at least 1/,
    );
  });

  test("cuaLaunchedProcess reads pid, else pids[0], from launch_app only", () => {
    const table: [string, string, { pid: number } | undefined][] = [
      ["launch_app", '{"pid":12,"windows":[]}', { pid: 12 }],
      ["launch_app", '{"pids":[34,35]}', { pid: 34 }],
      ["launch_app", '{"pid":12,"status":"refused"}', undefined],
      ["launch_app", '{"refusal":{}}', undefined],
      ["launch_app", '{"code":"not_found"}', undefined],
      ["launch_app", '{"pid":"12"}', undefined],
      ["launch_app", "[12]", undefined],
      ["launch_app", "not json", undefined],
      ["list_windows", '{"pid":12}', undefined],
    ];
    for (const [tool, stdout, expected] of table)
      expect(cuaLaunchedProcess(tool, stdout)).toEqual(expected);
  });
});
