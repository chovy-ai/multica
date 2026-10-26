// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localMessageDisplayContent } from "./local-protocol";

describe("local image message display", () => {
  it("hides standalone image markers while retaining authored paragraphs and the stored message", () => {
    const message = { role: "user" as const, attachmentIds: ["image-1", "image-2"], content: "Look at this\n\n[Image attachment: first.png]\n\n[Image attachment: second.jpg]\n\nKeep this paragraph" };
    expect(localMessageDisplayContent(message)).toBe("Look at this\n\nKeep this paragraph");
    expect(message.content).toContain("[Image attachment: first.png]");
    expect(localMessageDisplayContent({ ...message, content: "[Image attachment: first.png]" })).toBe("");
    expect(localMessageDisplayContent({ ...message, content: "[Image attachment: first.png]\n\nA question" })).toBe("A question");
  });
  it("preserves ordinary text, inline examples, assistant replies and unattached messages", () => {
    const content = "[Image attachment: example.png]";
    expect(localMessageDisplayContent({ role: "user", content })).toBe(content);
    expect(localMessageDisplayContent({ role: "assistant", content, attachmentIds: ["image"] })).toBe(content);
    const authored = "\n\nExample: [Image attachment: example.png]\n\n\nSecond paragraph";
    expect(localMessageDisplayContent({ role: "user", content: authored, attachmentIds: ["image"] })).toBe(authored);
    expect(localMessageDisplayContent()).toBe("");
  });
});
