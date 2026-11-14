import type { ReactNode } from "react";
import { FileText, BookOpen } from "lucide-react";
import { useLocale } from "../../../i18n";

export function MemoryFileHeader({
  path,
  children,
}: {
  path: string;
  children?: ReactNode;
}) {
  const Icon = path === "MEMORY.md" ? BookOpen : FileText;
  const slash = path.lastIndexOf("/");
  return (
    <header className="flex min-w-0 items-center gap-2 border-b px-3 py-3 md:px-4">
      <Icon
        className="hidden size-4 shrink-0 text-brand sm:block"
        aria-hidden="true"
      />
      <h2 className="min-w-0 flex-1 truncate text-label" title={path}>
        {slash >= 0 && (
          <span className="text-muted-foreground">
            {path.slice(0, slash)} /{" "}
          </span>
        )}
        {path.slice(slash + 1)}
      </h2>
      {children}
    </header>
  );
}

export function MemoryTimestamp({ value }: { value: string }) {
  const locale = useLocale();
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString(locale)}>
      {Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(date)}
    </time>
  );
}
