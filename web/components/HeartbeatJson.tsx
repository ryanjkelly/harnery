"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Collapsible JSON view of the raw heartbeat. Default collapsed because the
 * common case is "I just want the summary"; expand for diagnosis or schema
 * drift hunting. Mirrors the upstream app's HeartbeatJson.
 */
export function HeartbeatJson({
  heartbeat,
}: {
  heartbeat: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Raw heartbeat</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show JSON"}
        </Button>
      </CardHeader>
      {open && (
        <CardContent>
          <pre className="text-xs font-mono overflow-x-auto bg-muted/40 p-3 rounded-md">
            {JSON.stringify(heartbeat, null, 2)}
          </pre>
        </CardContent>
      )}
    </Card>
  );
}
