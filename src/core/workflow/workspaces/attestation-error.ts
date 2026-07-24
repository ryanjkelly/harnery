import type { WorkspaceAttestation, WorkspaceBinding } from "./types.ts";
import { isWorkspaceAttestation } from "./validate.ts";

export class WorkspaceAttestationError extends Error {
  readonly attestation: WorkspaceAttestation;

  constructor(message: string, attestation: WorkspaceAttestation) {
    super(message);
    this.name = "WorkspaceAttestationError";
    this.attestation = attestation;
  }
}

export function workspaceAttestationFromError(
  error: unknown,
  binding: WorkspaceBinding,
): WorkspaceAttestation | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (isWorkspaceAttestation(current, binding)) return current;
    if (typeof current !== "object") return undefined;
    if ("attestation" in current && isWorkspaceAttestation(current.attestation, binding)) {
      return current.attestation;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
