import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useAgentGUITimelineSelectAll } from "./useAgentGUITimelineSelectAll";

function Timeline({ enabled = true, children }: { enabled?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useAgentGUITimelineSelectAll(ref, enabled);
  return <div ref={ref} data-testid="timeline"><p>Message</p>{children}</div>;
}

function selectMessage() {
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("Message"));
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

afterEach(() => document.getSelection()?.removeAllRanges());

describe("useAgentGUITimelineSelectAll", () => {
  it("uses the selection when non-focusable message text sends keys to the body", () => {
    render(<Timeline />);
    selectMessage();
    expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(false);
    const range = document.getSelection()!.getRangeAt(0);
    expect(range.startContainer).toBe(screen.getByTestId("timeline"));
    expect(range.endContainer).toBe(screen.getByTestId("timeline"));
  });

  it("uses the keyboard target after a click clears the document selection", () => {
    render(<Timeline />);
    const timeline = screen.getByTestId("timeline");
    document.getSelection()!.removeAllRanges();
    expect(fireEvent.keyDown(timeline, { key: "a", ctrlKey: true })).toBe(false);
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(timeline);
  });

  it.each([
    { key: "a" },
    { key: "a", metaKey: true, altKey: true },
    { key: "a", ctrlKey: true, shiftKey: true },
    { key: "c", metaKey: true },
    { key: "a", metaKey: true, isComposing: true }
  ])("leaves other key combinations alone: %j", (keys) => {
    render(<Timeline />);
    selectMessage();
    expect(fireEvent.keyDown(document.body, keys)).toBe(true);
    expect(document.getSelection()!.toString()).toBe("Message");
  });

  it("leaves shortcuts already handled by a child alone", () => {
    render(<Timeline><button onKeyDown={(event) => event.preventDefault()}>Action</button></Timeline>);
    selectMessage();
    fireEvent.keyDown(screen.getByRole("button"), { key: "a", metaKey: true });
    expect(document.getSelection()!.getRangeAt(0).startContainer).not.toBe(screen.getByTestId("timeline"));
  });

  it.each([
    <input key="input" />,
    <textarea key="textarea" />,
    <select key="select"><option>Option</option></select>,
    <div key="rich-text" contentEditable suppressContentEditableWarning><span>Editor</span></div>,
    <div key="monaco" className="monaco-editor" tabIndex={0}>Editor</div>,
    <div key="codemirror" className="cm-editor" tabIndex={0}>Editor</div>
  ])("preserves editor shortcuts inside the timeline (%#)", (editor) => {
    render(<Timeline>{editor}</Timeline>);
    selectMessage();
    const target = screen.getByTestId("timeline").lastElementChild!;
    expect(fireEvent.keyDown(target.lastElementChild ?? target, { key: "a", ctrlKey: true })).toBe(true);
  });

  it("does not let a stale transcript selection steal keys from app controls", () => {
    render(<><button>App action</button><Timeline /></>);
    selectMessage();
    const outside = screen.getByRole("button");
    outside.focus();
    selectMessage();
    expect(fireEvent.keyDown(outside, { key: "a", metaKey: true })).toBe(true);
    expect(document.getSelection()!.toString()).toBe("Message");
  });

  it("ignores selections outside the timeline", () => {
    render(<><p>App text</p><Timeline /></>);
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("App text"));
    document.getSelection()!.addRange(range);
    expect(fireEvent.keyDown(document.body, { key: "a", metaKey: true })).toBe(true);
  });

  it("removes the handler when hidden, inactive or unmounted", () => {
    const rendered = render(<Timeline />);
    selectMessage();
    rendered.rerender(<Timeline enabled={false} />);
    expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(true);
    rendered.rerender(<Timeline />);
    selectMessage();
    rendered.unmount();
    expect(fireEvent.keyDown(document.body, { key: "a", metaKey: true })).toBe(true);
  });
});
