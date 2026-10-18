"use client";

import { useEffect, useMemo, useState } from "react";
import { useHostInfo } from "@/components/HostInfoProvider";
import { dashboardCommandClient } from "@/lib/dashboard-command-client";
import {
  type CommandArguments,
  type CommandReceipt,
  canonicalCommand,
  type DashboardAction,
} from "@/lib/dashboard-command-protocol";

export function useDashboardCommand(action: DashboardAction, target: CommandArguments) {
  const { repoRoot } = useHostInfo();
  const key = canonicalCommand(target);
  const client = useMemo(
    () => dashboardCommandClient(repoRoot, action, JSON.parse(key)),
    [repoRoot, action, key],
  );
  const [recovered, setRecovered] = useState<CommandReceipt | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setRecovered(null);
    setRecoveryError(null);
    if (repoRoot)
      void client.recover().then(
        (receipt) => {
          if (current) setRecovered(receipt);
        },
        (error) => {
          if (current) setRecoveryError(String(error));
        },
      );
    return () => {
      current = false;
    };
  }, [client, repoRoot]);
  return {
    recovered,
    recoveryError,
    async run<T>(args: CommandArguments): Promise<T> {
      setRecovered(null);
      setRecoveryError(null);
      const receipt = await client.submit(args);
      if (receipt.state !== "settled") {
        setRecovered(receipt);
        throw new Error(receipt.reason ?? "Original command is unconfirmed and retained.");
      }
      return receipt.result as T;
    },
  };
}
export function DashboardCommandRecovery({
  command,
}: {
  command: Pick<ReturnType<typeof useDashboardCommand>, "recovered" | "recoveryError">;
}) {
  if (command.recoveryError)
    return <span className="text-xs text-destructive">{command.recoveryError}</span>;
  const receipt = command.recovered;
  if (!receipt) return null;
  if (receipt.state !== "settled")
    return (
      <span className="text-xs text-muted-foreground">
        {receipt.reason} Original command retained.
      </span>
    );
  const result = receipt.result!;
  const detail =
    result.message ??
    result.error ??
    (result.ok === false
      ? "failed"
      : receipt.action === "ping"
        ? `pinged · ${result.bytes ?? "?"} bytes`
        : receipt.action === "release-claim"
          ? `released · ${result.remaining ?? "?"} claims remain`
          : result.terminal_event_queued
            ? "end queued"
            : "ended");
  return <span className="text-xs">{`Recovered ${receipt.action}: ${String(detail)}`}</span>;
}
