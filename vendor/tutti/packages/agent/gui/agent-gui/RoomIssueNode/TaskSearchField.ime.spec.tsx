import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { TaskSearchField } from "./TaskSearchField";

describe("TaskSearchField IME input", () => {
  it("commits the final Chinese value after composition ends", () => {
    const onChange = vi.fn();
    render(
      <TaskSearchField
        placeholder="Search files"
        value=""
        onChange={onChange}
      />
    );

    const input = screen.getByRole("searchbox");

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "pin" } });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      fireEvent.compositionEnd(input, { target: { value: "pin" } });
      fireEvent.change(input, { target: { value: "拼" } });
    });

    expect(onChange).toHaveBeenLastCalledWith("拼");
  });
});
