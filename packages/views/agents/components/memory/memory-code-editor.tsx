import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { editor } from "monaco-editor";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../../i18n";

export interface MemoryMarker {
  start: number;
  end: number;
  severity: "error" | "warning";
  message: string;
}
export interface MemoryEditorHandle {
  reveal(marker: MemoryMarker): void;
}
export interface MemoryCodeEditorProps {
  value: string;
  readOnly: boolean;
  label: string;
  markers?: MemoryMarker[];
  onChange?: (value: string) => void;
  onSave?: () => void;
  onCursor?: (line: number, column: number) => void;
  ref?: Ref<MemoryEditorHandle>;
}

export function MemoryCodeEditor({
  value,
  readOnly,
  label,
  markers = [],
  onChange,
  onSave,
  onCursor,
  ref,
}: MemoryCodeEditorProps) {
  const { t } = useT("agents");
  const { resolvedTheme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const synchronizing = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const change = usePersistCallback((text: string) => onChange?.(text));
  const save = usePersistCallback(() => onSave?.());
  const cursor = usePersistCallback((line: number, column: number) =>
    onCursor?.(line, column),
  );
  const initial = useRef({ value, readOnly, label });
  useImperativeHandle(
    ref,
    () => ({
      reveal(marker) {
        const code = instance.current;
        const model = code?.getModel();
        if (!code || !model) return;
        const start = model.getPositionAt(marker.start),
          end = model.getPositionAt(marker.end);
        code.setSelection({
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        });
        code.revealLineInCenterIfOutsideViewport(start.lineNumber);
        code.focus();
      },
    }),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setFailed(false);
    void import("./memory-monaco")
      .then(({ monaco }) => {
        if (cancelled || !container.current) return;
        const model = monaco.editor.createModel(
          initial.current.value,
          "agent-memory-markdown",
        );
        const styles = getComputedStyle(container.current);
        const code = monaco.editor.create(container.current, {
          model,
          readOnly: initial.current.readOnly,
          ariaLabel: initial.current.label,
          automaticLayout: true,
          editContext: false,
          minimap: { enabled: false },
          fontSize: parseFloat(styles.getPropertyValue("--text-label")) || 13,
          lineHeight: 25,
          fontFamily: styles.getPropertyValue("--font-mono").trim(),
          padding: { top: 24, bottom: 32 },
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          wordWrap: "off",
          glyphMargin: false,
          folding: false,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          renderValidationDecorations: "on",
          quickSuggestions: false,
          wordBasedSuggestions: "off",
          tabSize: 2,
          tabFocusMode: true,
          accessibilitySupport: "auto",
          stickyScroll: { enabled: false },
          scrollbar: { alwaysConsumeMouseWheel: false },
        });
        instance.current = code;
        const changes = code.onDidChangeModelContent(() => {
          if (!synchronizing.current) change(model.getValue());
        });
        const positions = code.onDidChangeCursorPosition((e) =>
          cursor(e.position.lineNumber, e.position.column),
        );
        code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
        setLoaded(true);
        dispose = () => {
          changes.dispose();
          positions.dispose();
          code.dispose();
          model.dispose();
          instance.current = null;
        };
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [change, cursor, retry, save]);
  useEffect(() => {
    const code = instance.current;
    if (!code) return;
    if (code.getValue() !== value) {
      const state = code.saveViewState();
      synchronizing.current = true;
      try {
        code.setValue(value);
      } finally {
        synchronizing.current = false;
      }
      if (state) code.restoreViewState(state);
    }
    code.updateOptions({ readOnly, ariaLabel: label });
    const input = code.getDomNode()?.querySelector('[role="textbox"]');
    input?.setAttribute(
      "aria-invalid",
      String(markers.some((m) => m.severity === "error")),
    );
    void import("./memory-monaco").then(({ monaco }) => {
      const model = code.getModel();
      if (!model || model.isDisposed()) return;
      monaco.editor.setModelMarkers(
        model,
        "agent-memory",
        markers.map((m) => {
          const start = model.getPositionAt(m.start),
            end = model.getPositionAt(m.end);
          return {
            message: m.message,
            severity:
              m.severity === "error"
                ? monaco.MarkerSeverity.Error
                : monaco.MarkerSeverity.Warning,
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: Math.max(
              end.column,
              start.column + (start.lineNumber === end.lineNumber ? 1 : 0),
            ),
          };
        }),
      );
    });
  }, [value, readOnly, label, markers, loaded]);
  useEffect(() => {
    if (!loaded || !container.current) return;
    // Monaco's theme API takes hex colors; resolve shared CSS tokens rather than
    // maintaining a separate editor palette.
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    canvas.width = canvas.height = 1;
    const styles = getComputedStyle(container.current);
    const color = (token: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = styles.getPropertyValue(token).trim();
      context.fillRect(0, 0, 1, 1);
      return (
        "#" +
        [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")
      );
    };
    void import("./memory-monaco").then(({ monaco }) => {
      monaco.editor.defineTheme("multica-memory", {
        base: resolvedTheme === "dark" ? "vs-dark" : "vs",
        inherit: true,
        rules: [
          { token: "key", foreground: color("--brand").slice(1) },
          { token: "keyword", foreground: color("--brand").slice(1) },
        ],
        colors: {
          "editor.background": color("--background"),
          "editor.foreground": color("--foreground"),
          "editorLineNumber.foreground": color("--muted-foreground"),
          "editorGutter.background": color("--background"),
          "editorError.foreground": color("--destructive"),
          "editorWarning.foreground": color("--warning"),
          "editor.selectionBackground": color("--surface-selected"),
        },
      });
      monaco.editor.setTheme("multica-memory");
    });
  }, [resolvedTheme, loaded]);
  return (
    <div className="relative h-full min-h-0 min-w-0">
      <div ref={container} className="absolute inset-0" />
      {!loaded && (
        <div
          role={failed ? "alert" : "status"}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-caption text-muted-foreground"
        >
          {failed ? t(($) => $.memory.failed) : t(($) => $.memory.loading)}
          {failed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((v) => v + 1)}
            >
              {t(($) => $.memory.retry)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
