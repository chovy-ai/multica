import type { DetailedHTMLProps, HTMLAttributes, RefAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          allowpopups?: boolean;
          partition?: string;
          src?: string;
        },
        HTMLElement
      > &
        RefAttributes<HTMLElement>;
    }
  }
}
