import Link from "next/link";

/** Alternate views of the same file area. Existing deep links remain valid. */
export function FileAreaNav({ active }: { active: "browse" | "images" }) {
  return (
    <nav
      aria-label="File views"
      className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-sm"
    >
      {[
        { href: "/browse", label: "Browse", key: "browse" },
        { href: "/images", label: "Images", key: "images" },
      ].map((view) => (
        <Link
          key={view.key}
          href={view.href}
          prefetch={false}
          aria-current={active === view.key ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 ${active === view.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          {view.label}
        </Link>
      ))}
      <Link
        href="/storage"
        prefetch={false}
        className="ml-auto rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted"
      >
        Storage
      </Link>
    </nav>
  );
}
