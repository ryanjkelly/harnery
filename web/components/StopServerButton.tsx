"use client";

import { Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  DashboardCommandRecovery,
  useDashboardCommand,
} from "@/components/DashboardCommandRecovery";
import { Button } from "@/components/ui/button";
import type { CommandArguments } from "@/lib/dashboard-command-protocol";

/** Stop one registered server (by id) or one unregistered listener (by pid). */
export function StopServerButton({
  id,
  pid,
  label,
  confirmMessage,
}: {
  id?: string;
  pid?: number;
  label: string;
  /** Ask before stopping; used for long-running services such as tunnels. */
  confirmMessage?: string;
}) {
  const router = useRouter();
  const target: CommandArguments = id ? { id } : { pid: pid ?? 0 };
  const command = useDashboardCommand("stop-server", target);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function stop() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError(null);
    startTransition(async () => {
      try {
        const data = await command.run<{ ok?: boolean; message?: string; error?: string }>(target);
        if (!data.ok) {
          setError(data.message ?? data.error ?? "stop failed");
          return;
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={stop}
        disabled={pending}
        aria-label={`Stop ${label}`}
      >
        <Square className="size-3" aria-hidden />
        {pending ? "Stopping…" : "Stop"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
      <DashboardCommandRecovery command={command} />
    </span>
  );
}
