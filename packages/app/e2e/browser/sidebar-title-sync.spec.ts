import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebSocketRoute } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { expect, test, type Page } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openHostSection } from "../support/helpers/settings";
import { closeSidebarDisplayPreferences, openSidebarDisplayPage } from "../support/helpers/sidebar";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";

const PLUGIN_ID = "sidebar-title-sync";
const SETTING_LABEL = "대화 탭 이름을 사이드바와 통일";
const RECONNECTED_TITLE = "재연결 이후 최신 이름 🛰️";
type SettingsRpcClient = Pick<DaemonClient, "invokePluginRpc" | "connect" | "close">;

async function setStoredEnabled(client: SettingsRpcClient, enabled: boolean) {
  const current = z
    .object({ status: z.literal("ready"), revision: z.string() })
    .parse(await client.invokePluginRpc(PLUGIN_ID, `settings.${PLUGIN_ID}.read`, {}));
  z.object({ status: z.literal("saved") }).parse(
    await client.invokePluginRpc(PLUGIN_ID, `settings.${PLUGIN_ID}.write`, {
      revision: current.revision,
      values: { schemaVersion: 1, enabled },
    }),
  );
}

async function removePluginFixtureDirectory(directory: string) {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(tmpdir()) ||
    !path.basename(target).startsWith("paseo-title-sync-e2e-")
  ) {
    throw new Error(`Refusing to remove an unexpected plugin fixture directory: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

async function copyTitleSyncPlugin() {
  const source = process.env.PASEO_TITLE_SYNC_PLUGIN_SOURCE
    ? path.resolve(process.env.PASEO_TITLE_SYNC_PLUGIN_SOURCE)
    : path.resolve(__dirname, "../../../../../..");
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-title-sync-e2e-"));
  try {
    const manifest = JSON.parse(await readFile(path.join(source, "paseo-plugin.json"), "utf8"));
    if (manifest.id !== PLUGIN_ID) {
      throw new Error(
        "Set PASEO_TITLE_SYNC_PLUGIN_SOURCE to the Sidebar Title Sync source directory.",
      );
    }
    for (const entry of ["index.client.tsx", "index.server.ts", "client", "server", "shared"]) {
      await cp(path.join(source, entry), path.join(directory, entry), { recursive: true });
    }
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ ...manifest, requirements: pluginRequirements }),
    );
    return { directory, cleanup: () => removePluginFixtureDirectory(directory) };
  } catch (error) {
    await removePluginFixtureDirectory(directory);
    throw error;
  }
}

function agentTab(page: Page, agentId: string) {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

async function expectSidebarAndTabs(
  page: Page,
  workspaceId: string,
  agentIds: string[],
  label: string,
) {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row.getByText(label, { exact: true })).toBeVisible();
  for (const agentId of agentIds) {
    const tab = agentTab(page, agentId);
    await expect(tab).toBeVisible();
    await expect(tab.getByText(label, { exact: true })).toBeVisible();
    await tab.hover({ position: { x: 12, y: 13 } });
    await expect(
      page.getByTestId(`workspace-tab-tooltip-agent_${agentId}`).getByText(label, { exact: true }),
    ).toBeVisible();
    await page.mouse.move(1100, 850);
  }
}

async function expectOriginalTitles(page: Page, agents: Array<{ id: string; title: string }>) {
  for (const agent of agents) {
    await expect(agentTab(page, agent.id).getByText(agent.title, { exact: true })).toBeVisible();
  }
}

async function setPluginEnabledInSettings(page: Page, enabled: boolean) {
  await openSettings(page);
  await openHostSection(page, getServerId(), "plugins");
  await page.getByRole("button", { name: `Actions for ${PLUGIN_ID}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Sidebar Title Sync", exact: true }).click();
  const toggle = page.getByRole("switch", { name: SETTING_LABEL, exact: true });
  await expect(toggle).toBeEnabled();
  if ((await toggle.isChecked()) !== enabled) await toggle.click();
  await expect(toggle).toBeEnabled();
  if (enabled) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
  await page.getByTestId("settings-back-to-workspace").filter({ visible: true }).first().click();
}

async function setSidebarTitleSource(page: Page, source: "title" | "branch") {
  await openSidebarDisplayPage(page, "sidebar-display-title-source");
  await page.getByTestId(`sidebar-workspace-title-source-${source}`).click();
  await closeSidebarDisplayPreferences(page);
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("syncs actual built-in tabs and tooltips while preserving saved agent titles", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const plugin = await copyTitleSyncPlugin();
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const settingsClient = await connectDaemonClient<SettingsRpcClient>({
    clientIdPrefix: "title-sync-settings-peer",
  });
  const network: { offline: boolean; browser: WebSocketRoute | null } = {
    offline: false,
    browser: null,
  };
  await page.routeWebSocket(daemonWsRoutePattern(), async (browser) => {
    if (network.offline) {
      await browser.close({ code: 1013, reason: "Offline title synchronization test." });
      return;
    }
    network.browser = browser;
    browser.connectToServer();
  });
  const workspace = await seedWorkspace({ repoPrefix: "title-sync-", title: "결제 기능 개선 🧾" });
  let installed = false;
  try {
    const agents: Awaited<ReturnType<typeof createMockIdleAgent>>[] = [];
    for (const title of ["주문 API 수정해줘", "영수증 조회 추가해줘"]) {
      agents.push(
        await createMockIdleAgent(workspace.client, {
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
        }),
      );
    }
    const agentIds = agents.map(({ id }) => id);
    for (const agent of agents) {
      await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, workspace.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await expect(agentTab(page, agent.id)).toHaveAttribute("aria-selected", "true");
    }
    await expectOriginalTitles(page, agents);

    await test.step("enabling updates active and inactive existing tabs and their tooltips", async () => {
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(plugin.directory);
      installed = true;
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "결제 기능 개선 🧾");
      await expect(agentTab(page, agents[0]!.id)).toHaveAttribute("aria-selected", "false");
      await expect(agentTab(page, agents[1]!.id)).toHaveAttribute("aria-selected", "true");
      await page.screenshot({ path: testInfo.outputPath("synced-tabs.png") });
    });

    await test.step("new conversations and a restored client use the same display rule", async () => {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "새 대화 원본 제목",
      });
      agents.push(agent);
      agentIds.push(agent.id);
      await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, workspace.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "결제 기능 개선 🧾");
    });

    await test.step("renaming and changing the sidebar display mode update both tabs", async () => {
      await client.setWorkspaceTitle(workspace.workspaceId, "정산 기능 검토 🎉");
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "정산 기능 검토 🎉");
      await setSidebarTitleSource(page, "branch");
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "main");
    });

    await test.step("offline cache survives disconnection and reconnect refreshes names and settings", async () => {
      await setSidebarTitleSource(page, "title");
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "정산 기능 검토 🎉");
      if (!network.browser)
        throw new Error("Expected a live browser connection to the isolated daemon.");
      network.offline = true;
      await page.context().setOffline(true);
      // Chromium keeps established WebSockets open when HTTP offline emulation starts.
      await network.browser.close({ code: 1013, reason: "Dropped by title synchronization test." });
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "정산 기능 검토 🎉");
      await client.setWorkspaceTitle(workspace.workspaceId, RECONNECTED_TITLE);
      await setStoredEnabled(settingsClient, false);
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "정산 기능 검토 🎉");
      network.offline = false;
      await page.context().setOffline(false);
      await expect(
        page
          .getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`)
          .getByText(RECONNECTED_TITLE, { exact: true }),
      ).toBeVisible();
      await expectOriginalTitles(page, agents);
      await setStoredEnabled(settingsClient, true);
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, RECONNECTED_TITLE);
      await page.screenshot({ path: testInfo.outputPath("reconnected-tabs.png") });
      await setSidebarTitleSource(page, "branch");
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "main");
    });

    await test.step("the persisted host setting restores and reapplies display titles", async () => {
      await setPluginEnabledInSettings(page, false);
      await expectOriginalTitles(page, agents);
      await setPluginEnabledInSettings(page, true);
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "main");
    });

    await test.step("reload, disable, enable, and removal clean up registrations", async () => {
      await client.reloadPlugin(PLUGIN_ID);
      await client.reloadPlugin(PLUGIN_ID);
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "main");
      await client.disablePlugin(PLUGIN_ID);
      await expectOriginalTitles(page, agents);
      await client.enablePlugin(PLUGIN_ID);
      await expectSidebarAndTabs(page, workspace.workspaceId, agentIds, "main");
      await client.removePlugin(PLUGIN_ID);
      installed = false;
      await expectOriginalTitles(page, agents);
      await page.screenshot({ path: testInfo.outputPath("restored-tabs.png") });
    });

    const saved = await workspace.client.fetchAgents();
    for (const agent of agents) {
      expect(saved.entries.find((entry) => entry.agent.id === agent.id)?.agent.title).toBe(
        agent.title,
      );
    }
    const savedWorkspace = await workspace.client.fetchWorkspaces();
    expect(savedWorkspace.entries.find((entry) => entry.id === workspace.workspaceId)?.name).toBe(
      RECONNECTED_TITLE,
    );
  } finally {
    await page.context().setOffline(false);
    if (installed) await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await settingsClient.close();
    await client.close();
    await workspace.cleanup();
    await plugin.cleanup();
  }
});
