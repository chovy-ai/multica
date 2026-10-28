import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { AgentAvatarControl } from "./agent-avatar-control";

const { upload, save, toastError } = vi.hoisted(() => ({
  upload: vi.fn(),
  save: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@multica/core/api", () => ({
  api: { getBaseUrl: () => "https://api.test" },
}));
vi.mock("@multica/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ upload }),
}));
// Canvas cropping has its own tests; retain the upload and persistence wiring.
vi.mock("../../common/avatar-crop-dialog", () => ({
  AvatarCropDialog: ({
    open,
    onCropped,
  }: {
    open: boolean;
    onCropped: (file: File) => void;
  }) =>
    open ? (
      <button
        onClick={() =>
          onCropped(new File(["cropped"], "avatar.png", { type: "image/png" }))
        }
      >
        Apply crop
      </button>
    ) : null,
}));

function Fixture({
  value = "/uploads/avatar.png",
  canEdit = true,
}: {
  value?: string | null;
  canEdit?: boolean;
}) {
  const [avatar, setAvatar] = useState(value);
  return (
    <AgentAvatarControl
      agent={{ name: "Lambda", avatar_url: avatar }}
      canEdit={canEdit}
      onChange={async (next) => {
        await save(next);
        setAvatar(next);
      }}
    />
  );
}

async function openPreview() {
  await userEvent.click(screen.getByRole("button", { name: "View avatar" }));
  return screen.findByRole("dialog", { name: "Avatar" });
}

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue(undefined);
  upload.mockResolvedValue({ link: "/uploads/new.png" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
});

describe("AgentAvatarControl", () => {
  it("opens from the keyboard, closes with Escape, and restores focus", async () => {
    renderWithI18n(<Fixture />);
    const trigger = screen.getByRole("button", { name: "View avatar" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Avatar" });
    expect(within(dialog).getByRole("img", { name: "Lambda" })).toHaveAttribute(
      "src",
      "https://api.test/uploads/avatar.png",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("lets read-only users preview and save without offering editing", async () => {
    const downloadURL = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, { desktopAPI: { downloadURL } });
    renderWithI18n(<Fixture canEdit={false} />);
    const dialog = await openPreview();
    expect(
      within(dialog).queryByRole("button", { name: "Change avatar" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save avatar" }),
    );
    expect(downloadURL).toHaveBeenCalledWith(
      "https://api.test/uploads/avatar.png",
    );
  });

  it("downloads the image bytes in Web without navigating to a cross-origin URL", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    const fetchImage = vi
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal("fetch", fetchImage);
    const createURL = vi.fn().mockReturnValue("blob:avatar");
    const revokeURL = vi.fn();
    Object.assign(URL, {
      createObjectURL: createURL,
      revokeObjectURL: revokeURL,
    });
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    renderWithI18n(<Fixture />);
    await openPreview();
    await userEvent.click(screen.getByRole("button", { name: "Save avatar" }));
    expect(fetchImage).toHaveBeenCalledWith(
      "https://api.test/uploads/avatar.png",
    );
    expect(createURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: "blob:avatar", download: "avatar" }]);
    await waitFor(() => expect(revokeURL).toHaveBeenCalledWith("blob:avatar"));
  });

  it.each(["network", "status", "content"])(
    "reports a Web download %s failure and allows retry",
    async (failure) => {
      const fetchImage = vi.fn();
      if (failure === "network")
        fetchImage.mockRejectedValue(new Error("offline"));
      else
        fetchImage.mockResolvedValue({
          ok: failure !== "status",
          blob: async () => new Blob(["error"], { type: "text/html" }),
        });
      vi.stubGlobal("fetch", fetchImage);
      renderWithI18n(<Fixture />);
      await openPreview();
      const button = screen.getByRole("button", { name: "Save avatar" });
      await userEvent.click(button);
      expect(toastError).toHaveBeenCalledWith("Could not save avatar");
      expect(button).toBeEnabled();
    },
  );

  it("reports a rejected Desktop bridge download", async () => {
    Object.assign(window, {
      desktopAPI: {
        downloadURL: vi.fn().mockRejectedValue(new Error("offline")),
      },
    });
    renderWithI18n(<Fixture />);
    await openPreview();
    await userEvent.click(screen.getByRole("button", { name: "Save avatar" }));
    expect(toastError).toHaveBeenCalledWith("Could not save avatar");
  });

  it("uploads through the existing crop flow and updates both preview and trigger", async () => {
    const { container } = renderWithI18n(<Fixture />);
    const dialog = await openPreview();
    await userEvent.click(
      screen.getByRole("button", { name: "Change avatar" }),
    );
    await screen.findByRole("button", { name: "Upload image" });
    const input = document.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [new File(["image"], "test.png", { type: "image/png" })],
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("/uploads/new.png"));
    expect(upload).toHaveBeenCalledWith(expect.any(File));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("img", { name: "Lambda" }),
      ).toHaveAttribute("src", "https://api.test/uploads/new.png"),
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://api.test/uploads/new.png",
    );
  });

  it("preserves the current image and crop UI when persistence fails", async () => {
    save.mockRejectedValue(new Error("forbidden"));
    renderWithI18n(<Fixture />);
    const dialog = await openPreview();
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["image"], "test.png", { type: "image/png" })],
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(within(dialog).getByRole("img", { name: "Lambda" })).toHaveAttribute(
      "src",
      "https://api.test/uploads/avatar.png",
    );
    expect(
      screen.getByRole("button", { name: "Apply crop" }),
    ).toBeInTheDocument();
  });

  it("lets editors switch to an emoji without offering a bogus image download", async () => {
    renderWithI18n(<Fixture />);
    const dialog = await openPreview();
    await userEvent.click(
      screen.getByRole("button", { name: "Change avatar" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "🦊" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("emoji:🦊"));
    expect(
      within(dialog).getByRole("img", { name: "Lambda" }),
    ).toHaveTextContent("🦊");
    expect(
      screen.queryByRole("button", { name: "Save avatar" }),
    ).not.toBeInTheDocument();
  });

  it.each([null, "emoji:🚀"])(
    "previews a non-image avatar (%s)",
    async (value) => {
      renderWithI18n(<Fixture value={value} />);
      await openPreview();
      expect(
        screen.queryByRole("button", { name: "Save avatar" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Change avatar" }),
      ).toBeEnabled();
    },
  );

  it("disables saving a failed image and recovers after the avatar changes", async () => {
    renderWithI18n(<Fixture />);
    const dialog = await openPreview();
    fireEvent.error(within(dialog).getByRole("img", { name: "Lambda" }));
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load image");
    expect(screen.getByRole("button", { name: "Save avatar" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Change avatar" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "🦊" }));
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(
      within(dialog).getByRole("img", { name: "Lambda" }),
    ).toHaveTextContent("🦊");
  });
});
