import { createContext, useContext, type ComponentProps } from "react";
import { MarkdownPre as OriginalMarkdownPre } from "../../../../vendor/tutti/packages/agent/gui/shared/AgentMessageMarkdownRenderers";
import { DocumentPreview } from "./preview";
import { codeBlockPreview } from "./code-block";
import { isClosedCodeBlock } from "./code-block-completion";
import { observer } from "mobx-react-lite";
export const MarkdownPre = observer(MarkdownPreRender);
const MarkdownSourceContext = createContext("");
export const MarkdownSourceProvider = MarkdownSourceContext.Provider;

function MarkdownPreRender(props: ComponentProps<typeof OriginalMarkdownPre>) {
  const source = useContext(MarkdownSourceContext);
  const preview =
    props.mermaidEnabled !== false ? codeBlockPreview(props.children) : null;
  return preview === null ? (
    <OriginalMarkdownPre {...props} />
  ) : (
    <DocumentPreview
      {...preview}
      streaming={(props.streaming ?? false) &&
        !(preview.format === "svg" && isClosedCodeBlock(source, props.node))}
    />
  );
}
