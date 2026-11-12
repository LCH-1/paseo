import { test } from "../../app/e2e/support/fixtures";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { startupScenario } from "../../app/e2e/support/helpers/startup-dsl";

test.describe("Desktop startup", () => {
  test("daemon bootstrap keeps the local server startup copy desktop-only", async ({ page }) => {
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withBlockedPort(getE2EDaemonPort())
      .openRoot();

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsSidebarHidden();
    await startup.expectsNoUndefinedRoute();
  });

  test("host-route refresh does not render route chrome around the bootstrap splash", async ({
    page,
  }) => {
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withBlockedPort(getE2EDaemonPort())
      .openHostWorkspace({
        serverId: getServerId(),
        workspaceId: "workspace-1",
      });

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsSidebarHidden();
  });

  test("new-workspace refresh preserves its draft while the desktop daemon becomes ready", async ({
    page,
  }) => {
    const target = { serverId: getServerId(), draftId: "startup-preserved-draft" };
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withSavedHost({
        serverId: "srv_unreachable_pending_startup",
        label: "Pending startup",
        endpoint: "127.0.0.1:45678",
      })
      .openNewWorkspace(target);

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsNewWorkspaceDraftRoute(target);
    await page.evaluate(() => {
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (!nonce) throw new Error("Expected the startup scenario seed nonce.");
      localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
    });
    await page.reload();
    await startup.expectsDesktopDaemonStartup();
    await startup.expectsNewWorkspaceDraftRoute(target);
    await startup.completeDesktopDaemon({
      serverId: target.serverId,
      listen: `127.0.0.1:${getE2EDaemonPort()}`,
    });
    await startup.expectsNewWorkspaceReady(target);
  });
});
