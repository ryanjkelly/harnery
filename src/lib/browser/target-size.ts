export type TargetSizeOutcome = "pass" | "fail" | "unknown";
export type TargetSizeProfile = "wcag-aa" | "comfortable";

export interface TargetSizeNode {
  outcome: TargetSizeOutcome;
  target: string[];
  html: string;
  message: string;
  failureSummary: string | null;
  relatedTargets: string[][];
  data: Record<string, unknown> | null;
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface TargetSizeResult {
  rule: "hit";
  selector: string | null;
  found: boolean;
  outcome: TargetSizeOutcome;
  profile: TargetSizeProfile;
  minSizePx: number;
  nodes: TargetSizeNode[];
}

interface AxeCheckResult {
  message: string;
  data: Record<string, unknown> | null;
  relatedNodes?: Array<{ target?: unknown }>;
}

interface AxeNodeResult {
  target?: unknown;
  html?: string;
  failureSummary?: string;
  any?: AxeCheckResult[];
  all?: AxeCheckResult[];
  none?: AxeCheckResult[];
}

interface AxeRuleResult {
  nodes?: AxeNodeResult[];
}

interface AxeResults {
  violations?: AxeRuleResult[];
  passes?: AxeRuleResult[];
  incomplete?: AxeRuleResult[];
}

declare global {
  interface Window {
    axe?: {
      configure: (config: unknown) => void;
      run: (context: unknown, options: unknown) => Promise<AxeResults>;
    };
  }
}

export function buildTargetSizeCheck(): (args: {
  selector: string | null;
  profile: TargetSizeProfile;
}) => Promise<TargetSizeResult> {
  return async ({ selector, profile }) => {
    const minSizePx = profile === "comfortable" ? 44 : 24;
    const axe = window.axe;
    if (!axe) throw new Error("Target-size engine was not injected into the page");
    const context = selector ? document.querySelector(selector) : document;
    if (!context) {
      return {
        rule: "hit",
        selector,
        found: false,
        outcome: "fail",
        profile,
        minSizePx,
        nodes: [],
      };
    }

    axe.configure({
      checks: [
        { id: "target-size", options: { minSize: minSizePx } },
        { id: "target-offset", options: { minOffset: minSizePx } },
      ],
    });
    const results = await axe.run(context, {
      runOnly: { type: "rule", values: ["target-size"] },
      rules: { "target-size": { enabled: true } },
      resultTypes: ["violations", "passes", "incomplete"],
    });

    const normalizeTarget = (target: unknown): string[] => {
      if (!Array.isArray(target)) return target == null ? [] : [String(target)];
      return target.map((part) =>
        Array.isArray(part) ? part.map(String).join(" >>> ") : String(part),
      );
    };
    const mapRuleNodes = (
      rules: AxeRuleResult[] | undefined,
      outcome: TargetSizeOutcome,
    ): TargetSizeNode[] =>
      (rules ?? []).flatMap((rule) =>
        (rule.nodes ?? []).map((node) => {
          const checks = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])];
          const check = checks[0];
          const target = normalizeTarget(node.target);
          let rect: TargetSizeNode["rect"] = null;
          const first = target[0];
          if (first && !first.includes(" >>> ")) {
            try {
              const element = document.querySelector(first);
              if (element) {
                const r = element.getBoundingClientRect();
                rect = { x: r.x, y: r.y, width: r.width, height: r.height };
              }
            } catch {
              rect = null;
            }
          }
          return {
            outcome,
            target,
            html: (node.html ?? "").slice(0, 300),
            message: (check?.message ?? "").slice(0, 500),
            failureSummary: node.failureSummary?.slice(0, 500) ?? null,
            relatedTargets: (check?.relatedNodes ?? []).map((related) =>
              normalizeTarget(related.target),
            ),
            data: check?.data ?? null,
            rect,
          };
        }),
      );

    const nodes = [
      ...mapRuleNodes(results.violations, "fail"),
      ...mapRuleNodes(results.incomplete, "unknown"),
      ...mapRuleNodes(results.passes, "pass"),
    ];
    const outcome: TargetSizeOutcome = nodes.some((node) => node.outcome === "fail")
      ? "fail"
      : nodes.some((node) => node.outcome === "unknown")
        ? "unknown"
        : "pass";
    return { rule: "hit", selector, found: true, outcome, profile, minSizePx, nodes };
  };
}

export function buildTargetSizeAnnotateScript(): (results: TargetSizeResult[]) => void {
  return (results) => {
    const ROOT_ID = "__harnery-target-size-annotations__";
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:0;overflow:visible;pointer-events:none;z-index:2147483647";
    document.body.appendChild(root);
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const result of results) {
      for (const node of result.nodes) {
        if (!node.rect || node.outcome === "pass") continue;
        const color = node.outcome === "fail" ? "#dc2626" : "#f59e0b";
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;left:${node.rect.x + sx}px;top:${node.rect.y + sy}px;width:${node.rect.width}px;height:${node.rect.height}px;border:2px solid ${color};box-sizing:border-box;background:${color}1a;pointer-events:none`;
        const tag = document.createElement("div");
        tag.textContent = `hit ${node.outcome} · ${result.minSizePx}px`;
        tag.style.cssText = `position:absolute;left:0;top:-18px;background:${color};color:white;font:12px/1.4 system-ui,sans-serif;padding:1px 5px;border-radius:3px;white-space:nowrap`;
        box.appendChild(tag);
        root.appendChild(box);
      }
    }
  };
}

export function buildClearTargetSizeAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__harnery-target-size-annotations__")?.remove();
  };
}
