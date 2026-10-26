import type * as React from "react";

export interface IconProps extends React.ComponentPropsWithoutRef<"svg"> {
  size?: number | string;
  title?: string;
}
