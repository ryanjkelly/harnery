/**
 * `harn open <url>`: open a web page in the person's default browser.
 *
 * Agents deliver a page as a link and open it only when the person asks to
 * see it. Each agent app has its own way to launch a browser, and some
 * approval reviews block a bare shell launch of an address. One reviewed
 * command that opens only an http(s) address in the operating system's
 * default browser gives every adapter the same path. Nothing is attached to
 * the browser and the command returns at once.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { isWSL } from "../lib/browser/launch-args.ts";

export interface OpenPlan {
  command: string;
  args: string[];
}

/** Only an ordinary web address may be opened; anything else is refused. */
export function parseOpenUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a web address: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https addresses open in the browser (got ${url.protocol}).`);
  }
  return url;
}

const WSL_RUNDLL32 = "/mnt/c/Windows/System32/rundll32.exe";

/**
 * How this host opens an address in its default browser. Windows and WSL use
 * the URL protocol handler, which takes the address as one argument, so no
 * shell parses its `&` or `%` characters.
 */
export function openPlan(
  url: URL,
  host: { platform: NodeJS.Platform; wsl: boolean; exists: (path: string) => boolean } = {
    platform: process.platform,
    wsl: isWSL(),
    exists: existsSync,
  },
): OpenPlan {
  const href = url.href;
  if (host.platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", href] };
  }
  if (host.wsl) {
    const command = host.exists(WSL_RUNDLL32) ? WSL_RUNDLL32 : "rundll32.exe";
    return { command, args: ["url.dll,FileProtocolHandler", href] };
  }
  if (host.platform === "darwin") return { command: "open", args: [href] };
  return { command: "xdg-open", args: [href] };
}

export function registerOpenCommand(program: Command, emit: EmitContext): void {
  program
    .command("open")
    .description(
      "Open a web page in the person's default browser, for when they ask to see it. Nothing is attached to the browser.",
    )
    .argument("<url>", "An http or https address")
    .option("--dry-run", "Print what would run without opening anything")
    .action((raw: string, opts: { dryRun?: boolean }) => {
      let url: URL;
      try {
        url = parseOpenUrl(raw);
      } catch (err) {
        emit.error({ code: "open_invalid_url", message: (err as Error).message });
        emit.setExitCode(1);
        return;
      }
      const plan = openPlan(url);
      if (opts.dryRun) {
        emit.data({ url: url.href, command: plan.command, args: plan.args, opened: false });
        return;
      }
      const child = spawn(plan.command, plan.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (err) => {
        emit.error({ code: "open_failed", message: `Could not open ${url.href}: ${err.message}` });
        emit.setExitCode(1);
      });
      child.unref();
      emit.data({ url: url.href, command: plan.command, opened: true });
      emit.log(`Opened ${url.href} in the default browser.`, "info");
    });
}
