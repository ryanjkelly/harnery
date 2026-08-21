import {
  Briefcase,
  Clapperboard,
  FileText,
  FolderTree,
  Image,
  LayoutDashboard,
  type LucideIcon,
  Radio,
  Scale,
  ScrollText,
  Target,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";

/**
 * The app's navigable surfaces — single source for the NavBar and the command
 * palette's Routes section. `group` drives the NavBar's visual separators
 * (related surfaces cluster together); `keywords` carry every synonym in use
 * across the nav label, page title, URL, and CLI noun so the palette finds a
 * route whichever vocabulary the operator reaches for.
 */
export interface AppRoute {
  href: string;
  label: string;
  /** Nav cluster: activity | direction | execution | library | misc. */
  group: string;
  icon: LucideIcon;
  keywords: string[];
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    href: "/",
    label: "Dashboard",
    group: "activity",
    icon: LayoutDashboard,
    keywords: ["home", "agents", "coordination", "overview", "timeline", "claims"],
  },
  {
    href: "/live",
    label: "Live",
    group: "activity",
    icon: Radio,
    keywords: ["session", "commands", "stream", "intent", "shell"],
  },
  {
    href: "/events",
    label: "Events",
    group: "activity",
    icon: ScrollText,
    keywords: ["ledger", "log", "v3", "stream", "history"],
  },
  {
    href: "/decisions",
    label: "Decisions",
    group: "direction",
    icon: Scale,
    keywords: ["docket", "tier", "review", "waiting", "precedent"],
  },
  {
    href: "/councils",
    label: "Councils",
    group: "direction",
    icon: Users,
    keywords: ["rounds", "steward", "contributions", "deliberation"],
  },
  {
    href: "/work",
    label: "Work",
    group: "execution",
    icon: Briefcase,
    keywords: ["durable work", "objectives", "attempts", "items"],
  },
  {
    href: "/governors",
    label: "Goals",
    group: "execution",
    icon: Target,
    keywords: ["governors", "durable goals", "missions", "specialist teams", "sweeps"],
  },
  {
    href: "/workflows",
    label: "Workflows",
    group: "execution",
    icon: Workflow,
    keywords: ["runs", "subagents", "stages", "transcripts", "wf"],
  },
  {
    href: "/files",
    label: "Files",
    group: "library",
    icon: FileText,
    keywords: ["viewer", "path", "deep link", "open file"],
  },
  {
    href: "/browse",
    label: "Browse",
    group: "library",
    icon: FolderTree,
    keywords: ["tree", "repo", "directory", "explorer", "search files"],
  },
  {
    href: "/images",
    label: "Images",
    group: "library",
    icon: Image,
    keywords: ["gallery", "screenshots", "produced", "thumbnails"],
  },
  {
    href: "/codec",
    label: "Codec",
    group: "misc",
    icon: Clapperboard,
    keywords: ["director", "roster", "team in motion", "ambience"],
  },
  {
    href: "/devtools",
    label: "Tools",
    group: "misc",
    icon: Wrench,
    keywords: ["devtools", "coding agents", "claude code", "codex", "cursor", "quota", "plans"],
  },
];

/** True when `pathname` is on (or under) the route — drives the active nav state. */
export function isRouteActive(routeHref: string, pathname: string): boolean {
  if (routeHref === "/") return pathname === "/";
  return pathname === routeHref || pathname.startsWith(`${routeHref}/`);
}
