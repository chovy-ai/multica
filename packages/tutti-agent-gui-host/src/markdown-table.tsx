import type { ComponentPropsWithoutRef } from "react";

export function MarkdownTable({ node: _node, ...props }: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
  return (
    <div className="min-w-0 max-w-full overflow-x-auto" data-multica-markdown-table tabIndex={0}>
      <table {...props} />
    </div>
  );
}
