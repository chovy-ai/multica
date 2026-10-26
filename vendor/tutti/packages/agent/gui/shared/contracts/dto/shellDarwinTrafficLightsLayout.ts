/**
 * Surface that owns the traffic-light alignment row.
 *
 * - `entry`：Dashboard / 登录 / 加载等首页类窗口；圆点只需对齐到行视觉中心（仅扣按钮半径）。
 * - `workspace`：房间窗口；在按钮半径之外再额外抬一个视觉微调，使圆点视觉中心略高于行几何中心，
 *   与设计师在房间窗口里确认的位置一致。
 *
 * 不传则按 `entry` 处理，保持向后兼容。
 */
export type ShellDarwinTrafficLightsSurface = "workspace" | "entry";

export type ShellDarwinTrafficLightsLayoutInput =
  | {
      mode: "workspace-row";
      rowCenterYPx: number;
      surface?: ShellDarwinTrafficLightsSurface;
    }
  | { mode: "fallback" };

export interface ShellDarwinNativeTrafficLightsVisibleInput {
  visible: boolean;
}
