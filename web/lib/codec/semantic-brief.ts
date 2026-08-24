import type { CodecSemanticChannel, CodecSemanticPresented } from "./contracts";

export type CodecSemanticBriefLineKind = "current" | "result" | "prediction";

export interface CodecSemanticBriefLine {
  kind: CodecSemanticBriefLineKind;
  label: "Now" | "Result" | "Predicted";
  text: string;
  field?: CodecSemanticPresented<string>;
  missing: boolean;
}

/** Select the three meaning lines that stay visible on every semantic card. */
export function codecSemanticBriefLines(
  semantic: CodecSemanticChannel,
): [CodecSemanticBriefLine, CodecSemanticBriefLine, CodecSemanticBriefLine] {
  if (semantic.state !== "current") {
    const reason = semantic.receipt?.reason_code
      ? ` · ${humanizeToken(semantic.receipt.reason_code)}`
      : "";
    return [
      {
        kind: "current",
        label: "Now",
        text: `Semantic reader ${humanizeToken(semantic.state)}${reason}`,
        missing: true,
      },
      {
        kind: "result",
        label: "Result",
        text: "No recent semantic result available",
        missing: true,
      },
      {
        kind: "prediction",
        label: "Predicted",
        text: "No next-step prediction available",
        missing: true,
      },
    ];
  }

  const current = semantic.headline ?? semantic.summary;
  return [
    line("current", "Now", current, "No current semantic read available"),
    line("result", "Result", semantic.recent_result, "No recent semantic result available"),
    line("prediction", "Predicted", semantic.next_step, "No next-step prediction available"),
  ];
}

function line(
  kind: CodecSemanticBriefLineKind,
  label: CodecSemanticBriefLine["label"],
  field: CodecSemanticPresented<string> | undefined,
  fallback: string,
): CodecSemanticBriefLine {
  return {
    kind,
    label,
    text: field?.value ?? fallback,
    ...(field ? { field } : {}),
    missing: !field,
  };
}

function humanizeToken(value: string): string {
  return value.replace(/[_-]+/g, " ");
}
