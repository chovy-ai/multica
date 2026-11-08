import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { problem, VerificationError } from "../host/problem.js";
import { exec, Simulator } from "../setup/ios.js";

/** Points are the simulator's screen coordinates, the same space as element frames. */
const point = z.object({ x: z.number().min(0), y: z.number().min(0) }).strict();
const elementTarget = z.union([
  z.object({ id: z.string().min(1).max(500) }).strict(),
  z.object({ label: z.string().min(1).max(500) }).strict(),
  point,
]);
/** HID usage IDs (keyboard page) of keys the software keyboard cannot type as text. */
const keys = {
  enter: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  arrowRight: 79,
  arrowLeft: 80,
  arrowDown: 81,
  arrowUp: 82,
} as const;
const commandKey = 227,
  vKey = 25;
export const iosActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tap"),
      target: elementTarget,
      /** Seconds to keep polling for an id/label match before giving up. */
      waitSeconds: z.number().min(0).max(30).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("longPress"),
      target: point,
      seconds: z.number().min(0.2).max(10).default(1),
    })
    .strict(),
  /** Pastes text into the focused field: any language, no input method involved. */
  z.object({ type: z.literal("type"), text: z.string().min(1).max(4000) }).strict(),
  z
    .object({ type: z.literal("key"), key: z.enum(Object.keys(keys) as [keyof typeof keys]) })
    .strict(),
  z
    .object({
      type: z.literal("swipe"),
      from: point,
      to: point,
      seconds: z.number().min(0.05).max(5).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("gesture"),
      preset: z.enum([
        "scroll-up",
        "scroll-down",
        "scroll-left",
        "scroll-right",
        "swipe-from-left-edge",
        "swipe-from-right-edge",
        "swipe-from-top-edge",
        "swipe-from-bottom-edge",
      ]),
    })
    .strict(),
  z
    .object({ type: z.literal("button"), button: z.enum(["home", "lock", "siri"]) })
    .strict(),
]);
export type IosAction = z.infer<typeof iosActionSchema>;

/** Content size categories accepted by `simctl ui content_size`. */
export const contentSizes = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;
export const iosDeviceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("appearance"), value: z.enum(["light", "dark"]) }).strict(),
  z.object({ type: z.literal("contentSize"), value: z.enum(contentSizes) }).strict(),
  z
    .object({
      type: z.literal("addMedia"),
      /** Images or videos committed in the environment's checkout, relative to its root. */
      paths: z.array(z.string().min(1).max(500)).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("openUrl"),
      url: z.string().regex(/^multica:\/\//, "Only multica:// links open inside the app"),
    })
    .strict(),
  /** Relaunches the app in this interface language instead of the system's. */
  z.object({ type: z.literal("language"), value: z.enum(["zh-Hans", "en"]) }).strict(),
  /** Cold-starts the app on the environment's Metro. */
  z.object({ type: z.literal("relaunch") }).strict(),
]);
export type IosDeviceSetting = z.infer<typeof iosDeviceSchema>;

const axeNode: z.ZodType<AxeNode> = z.lazy(() =>
  z
    .object({
      type: z.string().nullish(),
      role: z.string().nullish(),
      AXLabel: z.string().nullish(),
      AXValue: z.string().nullish(),
      AXUniqueId: z.string().nullish(),
      title: z.string().nullish(),
      enabled: z.boolean().nullish(),
      frame: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullish(),
      children: z.array(axeNode).default([]),
    })
    .passthrough(),
);
type AxeNode = {
  type?: string | null;
  role?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  title?: string | null;
  enabled?: boolean | null;
  frame?: { x: number; y: number; width: number; height: number } | null;
  children: AxeNode[];
};
export type IosElement = {
  type: string;
  id: string | null;
  label: string | null;
  value: string | null;
  enabled: boolean | null;
  frame: { x: number; y: number; width: number; height: number } | null;
  depth: number;
};

/**
 * Flattens AXe's accessibility tree into tree-ordered elements, keeping only
 * on-screen nodes that carry something a caller can target or read.
 */
export function flattenAccessibility(tree: unknown): IosElement[] {
  const roots = z.array(axeNode).parse(tree);
  const out: IosElement[] = [];
  // A dismissed keyboard and other parked views stay in the tree below the
  // screen; only elements that overlap the screen can be seen or tapped.
  const screen = roots[0]?.frame;
  const visible = (frame: AxeNode["frame"]) =>
    !screen ||
    !frame ||
    (frame.x < screen.x + screen.width &&
      frame.x + frame.width > screen.x &&
      frame.y < screen.y + screen.height &&
      frame.y + frame.height > screen.y);
  const visit = (node: AxeNode, depth: number) => {
    const label = node.AXLabel ?? node.title ?? null;
    if ((label || node.AXUniqueId || node.AXValue) && visible(node.frame))
      out.push({
        type: node.type ?? node.role ?? "Element",
        id: node.AXUniqueId ?? null,
        label,
        value: node.AXValue ?? null,
        enabled: node.enabled ?? null,
        frame: node.frame ?? null,
        depth,
      });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return out;
}

/**
 * Drives a simulator through AXe: the accessibility tree for reading,
 * HID events for input. Each call names its simulator by UDID, so concurrent
 * environments never contend for an application or a window.
 */
export class IosDriver {
  constructor(private readonly simulator: Simulator) {}
  private async axe(args: string[], timeout = 60_000) {
    return (
      await exec("axe", [...args, "--udid", this.simulator.udid], { timeout })
    ).stdout.toString("utf8");
  }
  async elements(): Promise<IosElement[]> {
    return flattenAccessibility(JSON.parse(await this.axe(["describe-ui"])));
  }
  async perform(action: IosAction): Promise<{ performed: true; detail: string }> {
    let output: string;
    switch (action.type) {
      case "tap": {
        const target = action.target;
        const args =
          "x" in target
            ? ["tap", "-x", String(target.x), "-y", String(target.y)]
            : [
                "tap",
                ...("id" in target ? ["--id", target.id] : ["--label", target.label]),
                ...(action.waitSeconds
                  ? ["--wait-timeout", String(action.waitSeconds)]
                  : []),
              ];
        output = await this.axe(args);
        break;
      }
      case "longPress":
        output = await this.axe([
          "touch",
          "-x",
          String(action.target.x),
          "-y",
          String(action.target.y),
          "--down",
          "--up",
          "--delay",
          String(action.seconds),
        ]);
        break;
      case "type":
        await this.simulator.setPasteboard(action.text);
        output = await this.axe(["key-combo", "--modifiers", String(commandKey), "--key", String(vKey)]);
        await this.simulator.setSoftwareKeyboard(true);
        break;
      case "key":
        output = await this.axe(["key", String(keys[action.key])]);
        await this.simulator.setSoftwareKeyboard(true);
        break;
      case "swipe":
        output = await this.axe([
          "swipe",
          "--start-x",
          String(action.from.x),
          "--start-y",
          String(action.from.y),
          "--end-x",
          String(action.to.x),
          "--end-y",
          String(action.to.y),
          ...(action.seconds ? ["--duration", String(action.seconds)] : []),
        ]);
        break;
      case "gesture":
        output = await this.axe(["gesture", action.preset]);
        break;
      case "button":
        output = await this.axe(["button", action.button]);
        break;
    }
    return { performed: true, detail: output.trim().split("\n").slice(-1)[0] ?? "" };
  }
}

/** Resolves checkout-relative media paths, refusing anything outside the checkout. */
export function checkoutMedia(checkout: string, paths: string[]): string[] {
  return paths.map((path) => {
    const absolute = resolve(checkout, path),
      inside = relative(checkout, absolute);
    if (isAbsolute(path) || inside.startsWith("..") || isAbsolute(inside))
      throw new VerificationError(
        problem("invalidInput", "Media paths must stay inside the environment checkout"),
      );
    return absolute;
  });
}
