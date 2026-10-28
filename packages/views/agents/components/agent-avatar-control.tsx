"use client";

import { useState } from "react";
import { Bot, Download, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import type { Agent } from "@multica/core/types";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { parseAvatarEmoji } from "@multica/ui/lib/avatar-emoji";
import { AvatarUploadControl } from "../../common/avatar-upload-control";
import { useT } from "../../i18n";

interface AgentAvatarControlProps {
  agent: Pick<Agent, "name" | "avatar_url">;
  canEdit: boolean;
  onChange: (value: string) => Promise<unknown>;
}

export function AgentAvatarControl({
  agent,
  canEdit,
  onChange,
}: AgentAvatarControlProps) {
  const { t } = useT("common");
  const [saving, setSaving] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const emoji = parseAvatarEmoji(agent.avatar_url);
  const imageUrl = emoji ? null : resolvePublicFileUrl(agent.avatar_url);
  const imageFailed = !!imageUrl && failedUrl === imageUrl;

  const saveImage = async () => {
    if (!imageUrl || imageFailed || saving) return;
    setSaving(true);
    try {
      // Match attachment downloads: Electron owns the native save dialog.
      const bridge = (
        window as unknown as {
          desktopAPI?: { downloadURL?: (url: string) => Promise<void> | void };
        }
      ).desktopAPI;
      if (bridge?.downloadURL) {
        await bridge.downloadURL(imageUrl);
      } else {
        // A blob URL makes cross-origin images download instead of navigating.
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error("Avatar download failed");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/"))
          throw new Error("Invalid avatar image");
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "avatar";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Safari needs the blob alive until the click has been processed.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      toast.error(t(($) => $.avatar_preview.save_failed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog>
      <DialogTrigger
        aria-label={t(($) => $.avatar_preview.open)}
        className="inline-flex shrink-0 cursor-zoom-in rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ActorAvatar
          name={agent.name}
          initials=""
          avatarUrl={emoji ? agent.avatar_url : imageUrl}
          isAgent
          size="2xl"
          className="ring-1 ring-border"
        />
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>{t(($) => $.avatar_preview.title)}</DialogTitle>
        </DialogHeader>
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
          {imageUrl && !imageFailed ? (
            <img
              key={imageUrl}
              src={imageUrl}
              alt={agent.name}
              className="h-full w-full object-contain"
              onError={() => setFailedUrl(imageUrl)}
            />
          ) : emoji ? (
            <span role="img" aria-label={agent.name} className="text-display">
              {emoji}
            </span>
          ) : (
            <Bot className="size-24" aria-hidden="true" />
          )}
        </div>
        {imageFailed && (
          <p role="status" className="text-body text-muted-foreground">
            {t(($) => $.avatar_crop.load_failed)}
          </p>
        )}
        {(imageUrl || canEdit) && (
          <DialogFooter>
            {imageUrl && (
              <Button
                variant="outline"
                disabled={saving || imageFailed}
                aria-busy={saving || undefined}
                onClick={saveImage}
              >
                <Download />
                {t(($) => $.avatar_preview.save)}
              </Button>
            )}
            {canEdit && (
              <AvatarUploadControl
                variant="agent"
                value={agent.avatar_url ?? null}
                name={agent.name}
                onUploaded={onChange}
                onEmojiSelected={onChange}
                trigger={
                  <Button>
                    <ImagePlus />
                    {t(($) => $.avatar_upload.change)}
                  </Button>
                }
              />
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
