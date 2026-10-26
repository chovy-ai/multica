export type UISystemDevManifest = {
  packageName: "@tutti-os/ui-system";
  version: string;
  entrypoints: Record<string, string>;
  tailwindSourceRoot: "src";
  componentsMetadata: "src/metadata/components.json";
};

export type UISystemDevFile = {
  path: string;
  hash: string;
  size: number;
};

export type UISystemDevEvent =
  | { type: "fileChanged"; path: string; hash: string }
  | { type: "fileDeleted"; path: string }
  | { type: "manifestChanged" }
  | { type: "componentsChanged" };
