import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { useLocale } from "../../../i18n";

export function MemoryFileHeader({
  path,
  children,
}: {
  path: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-2 border-b px-4 py-3 md:px-6">
      <FileText
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="min-w-0 flex-1 truncate font-mono text-label" title={path}>
        {path}
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
