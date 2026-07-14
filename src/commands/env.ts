import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, EnvCheck, EnvSection, HarneryProgramContext } from "../commander.ts";
import { exec, sh } from "../lib/exec.ts";

/**
 * `env`: show environment status across the generic sections (runtimes,
 * docker, git) plus any sections the host registers via `context.envSections`.
 * harnery core carries no provider-specific checks (a host adds e.g. gcp/bq).
 *
 * Monorepo state (repoRoot, submodules) flows in via HarneryProgramContext.
 * When neither is provided (harn invoked outside a monorepo), the git section
 * reports just the current branch and skips the submodule row.
 *
 * Color hints are intentionally string labels (`"ok"`/`"missing"`/...) rather
 * than ANSI-wrapper functions, so consumer adapters can consume them as
 * metadata; defaultEmit just JSON-stringifies.
 */

// Internal alias for the shared row type (exported from commander.ts so hosts
// can type their own `envSections`).
type Check = EnvCheck;

export function registerEnvCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("env [section]")
    .description("Show environment status (runtimes, docker, git; hosts can add sections)")
    .action(async (section?: string) => {
      try {
        await handleEnv(section, emit, context);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "env_error", message: msg });
        process.exit(1);
      }
    });
}

async function handleEnv(
  section: string | undefined,
  emit: EmitContext,
  context: HarneryProgramContext | undefined,
): Promise<void> {
  const sections: Record<string, EnvSection> = {
    runtimes: checkRuntimes,
    docker: checkDocker,
    git: () => checkGit(context),
    // Host-registered sections (e.g. gcp/bq) merge in after the generic ones.
    ...(context?.envSections ?? {}),
  };

  if (section) {
    const fn = sections[section];
    if (!fn) {
      emit.error({
        code: "unknown_section",
        message: `Unknown section "${section}". Valid: ${Object.keys(sections).join(", ")}`,
      });
      process.exit(1);
    }
    const checks = await fn();
    emit.data({ ok: true, section, checks: checks.map(toRow) });
    return;
  }

  const results = await Promise.all(
    Object.entries(sections).map(async ([name, fn]) => ({
      name,
      checks: await fn().catch(() => [
        { label: name, value: "check failed", status: "missing" as const },
      ]),
    })),
  );

  emit.data({
    ok: true,
    sections: Object.fromEntries(results.map(({ name, checks }) => [name, checks.map(toRow)])),
  });
}

function toRow(check: Check): { label: string; value: string } {
  return { label: check.label, value: check.value };
}

async function checkRuntimes(): Promise<Check[]> {
  const checks: Check[] = [];

  const [node, bun, python, php] = await Promise.all([
    exec(["node", "--version"]).catch(() => ({ stdout: "", exitCode: 1, stderr: "" })),
    exec(["bun", "--version"]).catch(() => ({ stdout: "", exitCode: 1, stderr: "" })),
    exec(["python3", "--version"]).catch(() => ({ stdout: "", exitCode: 1, stderr: "" })),
    exec(["php", "--version"]).catch(() => ({ stdout: "", exitCode: 1, stderr: "" })),
  ]);

  if (node.exitCode === 0) checks.push({ label: "Node.js", value: node.stdout, status: "ok" });
  else checks.push({ label: "Node.js", value: "not found", status: "missing" });

  if (bun.exitCode === 0) checks.push({ label: "Bun", value: bun.stdout, status: "ok" });
  else checks.push({ label: "Bun", value: "not found", status: "missing" });

  if (python.exitCode === 0)
    checks.push({ label: "Python", value: python.stdout.replace("Python ", ""), status: "ok" });
  else checks.push({ label: "Python", value: "not found", status: "missing" });

  if (php.exitCode === 0) {
    const ver = php.stdout.split("\n")[0]?.match(/PHP (\S+)/)?.[1] ?? php.stdout;
    checks.push({ label: "PHP", value: ver, status: "ok" });
  } else {
    checks.push({ label: "PHP", value: "not found", status: "info" });
  }

  return checks;
}

async function checkDocker(): Promise<Check[]> {
  const checks: Check[] = [];

  const dockerVersion = await exec(["docker", "--version"]).catch(() => ({
    stdout: "",
    exitCode: 1,
    stderr: "",
  }));

  if (dockerVersion.exitCode !== 0) {
    return [{ label: "Docker", value: "not installed", status: "missing" }];
  }

  const ver = dockerVersion.stdout.match(/Docker version (\S+)/)?.[1] ?? dockerVersion.stdout;
  checks.push({ label: "Docker", value: ver, status: "ok" });

  const ps = await sh('docker ps --format "{{.Names}}" 2>/dev/null').catch(() => ({
    stdout: "",
    exitCode: 1,
    stderr: "",
  }));

  if (ps.exitCode === 0) {
    const names = ps.stdout.split("\n").filter(Boolean);
    checks.push({
      label: "Containers",
      value: names.length > 0 ? `${names.length} running` : "none running",
      status: names.length > 0 ? "ok" : "info",
    });
  } else {
    checks.push({ label: "Containers", value: "docker ps unavailable", status: "info" });
  }

  return checks;
}

async function checkGit(context: HarneryProgramContext | undefined): Promise<Check[]> {
  const checks: Check[] = [];
  const cwd = context?.repoRoot ?? process.cwd();

  const branch = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  checks.push({ label: "Branch", value: branch.stdout, status: "info" });

  if (context?.repoRoot && context.submodules && context.submodules.length > 0) {
    const initialized = context.submodules.filter((name) =>
      isSubmoduleInitialized(resolve(context.repoRoot as string, name)),
    );
    const total = context.submodules.length;
    checks.push({
      label: "Submodules",
      value: `${initialized.length}/${total} initialized`,
      status: initialized.length === total ? "ok" : "warn",
    });
  }

  return checks;
}

function isSubmoduleInitialized(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    // readdirSync lists every entry (dotfiles included, `.`/`..` excluded):
    // the non-recursive "is this dir non-empty?" check this needs, on both
    // Bun and Node (replaces the Bun-only `new Bun.Glob("*").scanSync`).
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
