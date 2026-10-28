import { LoginPage } from "@multica/views/auth";
import { DragStrip } from "@multica/views/platform";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { useT } from "@multica/views/i18n";
import { toast } from "sonner";

export function DesktopLoginPage() {
  const { t } = useT("auth");
  const handleGoogleLogin = () => {
    void window.desktopAPI.beginBrowserLogin().catch(() => {
      toast.error(t(($) => $.web.desktop_handoff.prepare_failed));
    });
  };

  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <LoginPage
        logo={<MulticaIcon bordered size="lg" />}
        onSuccess={() => {
          // Auth store update triggers AppContent re-render → shows DesktopShell.
          // Initial workspace navigation happens in routes.tsx via IndexRedirect.
        }}
        onGoogleLogin={handleGoogleLogin}
      />
    </div>
  );
}
