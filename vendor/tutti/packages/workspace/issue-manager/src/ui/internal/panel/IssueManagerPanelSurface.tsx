import { type JSX, type ReactNode } from "react";
import { Button, FileCreateIcon, cn } from "@tutti-os/ui-system";

const issueManagerLoadingBoneClassName =
  "h-4 rounded-[4px] bg-[var(--transparency-block)]";

export function IssueManagerEmptyIllustration({
  src
}: {
  src: string;
}): JSX.Element {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="h-[84px] w-[84px] object-contain"
      decoding="async"
      draggable={false}
      src={src}
    />
  );
}

export function IssueManagerTaskEmptyState({
  body,
  ctaLabel,
  illustration,
  onCreate,
  title
}: {
  body: string;
  ctaLabel: string;
  illustration?: ReactNode;
  onCreate: () => void;
  title: string;
}): JSX.Element {
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 py-10 text-center">
      <div className="grid max-w-[420px] justify-items-center gap-2">
        {illustration ? <div className="mb-2">{illustration}</div> : null}
        <p className="text-[15px] font-semibold leading-[1.35] text-[var(--text-primary)]">
          {title}
        </p>
        <p className="max-w-[420px] text-[15px] leading-[1.3] text-[var(--text-secondary)]">
          {body}
        </p>
        <Button
          className="mt-2 gap-2 px-[18px]"
          size="dialog"
          type="button"
          onClick={onCreate}
        >
          <FileCreateIcon size={16} />
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
}

export function IssueManagerPaneLoadingState(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="mx-auto flex w-full max-w-4xl flex-col gap-9"
    >
      <div className={cn(issueManagerLoadingBoneClassName, "w-28")} />
      <div className={cn(issueManagerLoadingBoneClassName, "w-2/3")} />
      <div className="grid gap-3">
        <div className={cn(issueManagerLoadingBoneClassName, "w-24")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-full")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-11/12")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-10/12")} />
      </div>
      <div className="grid gap-3">
        <div className={cn(issueManagerLoadingBoneClassName, "w-32")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-full")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-9/12")} />
      </div>
    </div>
  );
}

export function IssueManagerTaskListLoadingState(): JSX.Element {
  return (
    <div aria-hidden="true" className="overflow-hidden bg-transparent">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          className="border-b border-border/70 px-3.5 py-3.5 last:border-b-0"
          key={index}
        >
          <div className="flex items-center justify-between gap-3">
            <div className={cn(issueManagerLoadingBoneClassName, "w-2/5")} />
            <div className={cn(issueManagerLoadingBoneClassName, "w-20")} />
          </div>
          <div
            className={cn(issueManagerLoadingBoneClassName, "mt-3 w-full")}
          />
          <div className={cn(issueManagerLoadingBoneClassName, "mt-2 w-4/5")} />
        </div>
      ))}
    </div>
  );
}

export function IssueManagerTaskDrawerLoadingState(): JSX.Element {
  return (
    <div aria-hidden="true" className="grid gap-5">
      <div className={cn(issueManagerLoadingBoneClassName, "w-full")} />
      <div className="grid grid-cols-2 gap-3">
        <div className={issueManagerLoadingBoneClassName} />
        <div className={issueManagerLoadingBoneClassName} />
      </div>
      <div className="grid gap-3">
        <div className={cn(issueManagerLoadingBoneClassName, "w-24")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-full")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-11/12")} />
        <div className={cn(issueManagerLoadingBoneClassName, "w-9/12")} />
      </div>
    </div>
  );
}
