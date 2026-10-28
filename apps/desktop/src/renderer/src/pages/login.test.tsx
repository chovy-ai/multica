import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), toast: vi.fn(), external: vi.fn() }));
vi.mock("@multica/views/auth", () => ({ LoginPage: ({ onGoogleLogin }: { onGoogleLogin: () => void }) => <button onClick={onGoogleLogin}>Browser sign-in</button> }));
vi.mock("@multica/views/platform", () => ({ DragStrip: () => null }));
vi.mock("@multica/ui/components/common/multica-icon", () => ({ MulticaIcon: () => null }));
vi.mock("@multica/views/i18n", () => ({ useT: () => ({ t: () => "Unable to prepare sign-in" }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
import { DesktopLoginPage } from "./login";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue(undefined);
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { beginBrowserLogin: mocks.begin, openExternal: mocks.external } });
});

describe("DesktopLoginPage", () => {
  it("starts the owning instance's login instead of a global protocol browser URL", () => {
    render(<DesktopLoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Browser sign-in" }));
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("shows a recoverable error if browser login cannot start", async () => {
    mocks.begin.mockRejectedValue(new Error("port unavailable"));
    render(<DesktopLoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Browser sign-in" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Unable to prepare sign-in"));
  });
});
