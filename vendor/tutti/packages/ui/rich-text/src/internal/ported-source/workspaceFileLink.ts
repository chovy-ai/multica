import { mergeAttributes, Node } from "@tiptap/core";
import { resolveWorkspaceFileVisualKind } from "../workspaceFileManager/workspaceFileManagerModel";

export const WorkspaceFileLink = Node.create({
  name: "workspaceFileLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: {
        default: ""
      },
      path: {
        default: ""
      },
      href: {
        default: ""
      },
      kind: {
        default: "file"
      }
    };
  },

  parseHTML() {
    return [{ tag: "a[data-workspace-file-link]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const visualKind = resolveWorkspaceFileVisualKind(
      HTMLAttributes.path || HTMLAttributes.name || "",
      { refType: HTMLAttributes.kind || "file" }
    );
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-workspace-file-link": "true",
        "data-workspace-file-kind": HTMLAttributes.kind || "file",
        "data-workspace-file-visual-kind": visualKind,
        "data-workspace-path": HTMLAttributes.path || "",
        href: HTMLAttributes.href || "",
        class:
          "tsh-workspace-file-link tsh-agent-object-token tsh-agent-object-token--file"
      }),
      [
        "span",
        { class: "tsh-agent-object-token__icon", "aria-hidden": "true" },
        ""
      ],
      [
        "span",
        { class: "tsh-agent-object-token__main" },
        HTMLAttributes.name ||
          HTMLAttributes.path ||
          HTMLAttributes.href ||
          "file"
      ]
    ];
  },

  renderText({ node }) {
    const attrs = (node.attrs ?? {}) as Record<string, string>;
    const name = attrs.name || attrs.path || "file";
    const href = attrs.href || "";
    return href ? `[${name}](${href})` : name;
  }
});
