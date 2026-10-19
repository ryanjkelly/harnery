import { spyOn } from "bun:test";
import { readFileSync, readSync, writeSync } from "node:fs";
import { createLocalGitWorktreeProvider } from "../local-git.ts";
import * as ownership from "../ownership.ts";
import { readWorkspaceClaim } from "../state.ts";
import type { WorkspaceBinding } from "../types.ts";

const [root, bindingPath, mode] = process.argv.slice(2);
if (!root || !bindingPath || !mode)
  throw new Error("reservation fixture requires root, binding and mode");
const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as WorkspaceBinding;
const claim = readWorkspaceClaim(root, binding.provider.id, binding.binding_id)!;
function handshake() {
  writeSync(1, `RESERVED ${process.pid}\n`);
  const input = Buffer.alloc(1);
  if (readSync(0, input, 0, 1, null) !== 1) throw new Error("reservation handshake closed");
}

if (mode === "reclaim") {
  // Expiry is deterministic; the real process probe must still refuse the live owner.
  spyOn(Date, "now").mockReturnValue(1_000);
  const reserve = ownership.reserveWorkspaceReclaim;
  spyOn(ownership, "reserveWorkspaceReclaim").mockImplementation((coordRoot, candidate) => {
    const held = reserve(coordRoot, candidate);
    held.assertCurrent();
    handshake();
    return held;
  });
  await createLocalGitWorktreeProvider({ coordRoot: root }).reclaim(binding, {
    mode: "discard",
    yes: true,
  });
} else if (mode === "recover") {
  const held = ownership.reserveWorkspaceReclaim(root, claim);
  try {
    held.assertCurrent();
    handshake();
  } finally {
    held.release();
  }
  writeSync(1, "RELEASED\n");
} else throw new Error(`unknown reservation fixture mode: ${mode}`);
