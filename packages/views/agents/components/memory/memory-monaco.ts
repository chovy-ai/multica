import "monaco-editor/esm/vs/editor/editor.all.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// @ts-expect-error Monaco's Markdown tokenizer is published without declarations.
import * as markdown from "monaco-editor/esm/vs/basic-languages/markdown/markdown";
import type { languages } from "monaco-editor";
const { conf, language } = markdown as {
  conf: languages.LanguageConfiguration;
  language: languages.IMonarchLanguage;
};
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";

// Bundle the editor worker locally; memory content never leaves the device.
if (!globalThis.MonacoEnvironment) {
  globalThis.MonacoEnvironment = {
    getWorker: () =>
      new Worker(new URL("./memory-editor.worker.ts", import.meta.url), {
        type: "module",
      }),
  };
}
monaco.languages.register({ id: "agent-memory-markdown" });
monaco.languages.setLanguageConfiguration("agent-memory-markdown", conf);
monaco.languages.setMonarchTokensProvider("agent-memory-markdown", {
  ...language,
  tokenizer: {
    ...language.tokenizer,
    root: [
      [
        /^---$/,
        { token: "metatag", next: "@frontmatter", nextEmbedded: "yaml" },
      ],
      ...(language.tokenizer.root ?? []),
    ],
    body: language.tokenizer.root ?? [],
    frontmatter: [
      [/^---$/, { token: "metatag", switchTo: "@body", nextEmbedded: "@pop" }],
    ],
  },
});
export { monaco };
