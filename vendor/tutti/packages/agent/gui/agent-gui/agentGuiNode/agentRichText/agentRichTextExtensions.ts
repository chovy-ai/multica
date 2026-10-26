import { Extension, type Extensions } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import {
  createAgentFileMentionExtension,
  type AgentFileMentionExtensionOptions
} from "./agentFileMentionExtension";
import {
  createAgentCapabilityTokenExtension,
  type AgentCapabilityTokenExtensionOptions
} from "./agentCapabilityTokenExtension";
import {
  createAgentSkillTokenExtension,
  type AgentSkillTokenExtensionOptions
} from "./agentSkillTokenExtension";

function createAgentPromptStarterKit(): Extensions[0] {
  return StarterKit.configure({
    blockquote: false,
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    link: false,
    listItem: false,
    listKeymap: false,
    orderedList: false,
    strike: false,
    trailingNode: false,
    underline: false
  });
}

function createAgentTokenKeyboardExtension(): Extensions[0] {
  return Extension.create({
    name: "agentTokenKeyboard",

    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handleKeyDown(view, event) {
              if (event.key !== "Backspace" && event.key !== "ArrowLeft") {
                return false;
              }
              const { doc, selection } = view.state;
              if (
                selection instanceof NodeSelection &&
                isSelectableAgentToken(selection.node)
              ) {
                event.preventDefault();
                if (event.key === "ArrowLeft") {
                  view.dispatch(
                    view.state.tr.setSelection(
                      TextSelection.create(doc, selection.from)
                    )
                  );
                } else {
                  view.dispatch(
                    view.state.tr.delete(selection.from, selection.to)
                  );
                }
                return true;
              }
              if (!selection.empty) {
                return false;
              }
              const nodeBefore = selection.$from.nodeBefore;
              if (!nodeBefore || !isSelectableAgentToken(nodeBefore)) {
                return false;
              }
              event.preventDefault();
              view.dispatch(
                view.state.tr.setSelection(
                  NodeSelection.create(
                    doc,
                    selection.from - nodeBefore.nodeSize
                  )
                )
              );
              return true;
            }
          }
        })
      ];
    }
  });
}

function isSelectableAgentToken(
  node: { type: { name: string }; nodeSize: number } | null
): boolean {
  return (
    node?.type.name === "agentSkillToken" ||
    node?.type.name === "agentCapabilityToken"
  );
}

export function createAgentRichTextInputExtensions(
  fileMentionOptions?: AgentFileMentionExtensionOptions,
  skillTokenOptions?: AgentSkillTokenExtensionOptions,
  capabilityTokenOptions?: AgentCapabilityTokenExtensionOptions
): Extensions {
  return [
    createAgentTokenKeyboardExtension(),
    createAgentPromptStarterKit(),
    createAgentFileMentionExtension(fileMentionOptions),
    createAgentCapabilityTokenExtension(capabilityTokenOptions),
    createAgentSkillTokenExtension(skillTokenOptions)
  ];
}

export function createAgentRichTextReadonlyExtensions(
  skillTokenOptions?: AgentSkillTokenExtensionOptions,
  capabilityTokenOptions?: AgentCapabilityTokenExtensionOptions
): Extensions {
  return [
    createAgentPromptStarterKit(),
    createAgentFileMentionExtension({
      enableSuggestions: false,
      renderAsLink: true
    }),
    createAgentCapabilityTokenExtension(capabilityTokenOptions),
    createAgentSkillTokenExtension(skillTokenOptions)
  ];
}
