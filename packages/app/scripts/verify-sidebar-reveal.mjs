import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { chromium } from "playwright";

const source = await readFile(
  new URL("../src/components/sidebar/sidebar-workspace-scroll.ts", import.meta.url),
  "utf8",
);
const { code } = await transform(source, { loader: "ts", format: "iife", globalName: "reveal" });
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`
    <style>
      body { margin:0; }
      #outer {height:620px;overflow:auto}
      #sidebar {margin-top:70px;width:300px;height:480px;overflow:auto;overflow-anchor:none}
      .row {height:42px}
    </style>
    <div style="display:none" data-testid="sidebar-project-workspace-list-scroll">
      <div data-testid="sidebar-workspace-row-host:target">hidden copy</div>
    </div>
    <div id="outer"><div id="sidebar" data-testid="sidebar-project-workspace-list-scroll">
      <div id="content"><div id="before" style="height:1700px"></div>
        <div class="row" data-testid="sidebar-workspace-row-other:target">other host</div>
        <div id="target" class="row" data-testid="sidebar-workspace-row-host:target">target</div>
        <div style="height:1700px"></div>
      </div>
    </div><div style="height:1200px"></div></div>
  `);
  await page.addScriptTag({ content: code });
  const measure = () =>
    page.evaluate(() => {
      const sidebar = document.getElementById("sidebar");
      const bounds = document.getElementById("target").getBoundingClientRect();
      const viewport = sidebar.getBoundingClientRect();
      return {
        top: sidebar.scrollTop,
        visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
        centered: Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2) < 2,
        outerTop: document.getElementById("outer").scrollTop,
      };
    });
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  async function checkCentered() {
    await settle();
    const result = await measure();
    assert.equal(result.visible, true);
    assert.equal(result.centered || result.top === 0, true);
    assert.equal(result.outerTop, 0);
    checks++;
  }
  await page.evaluate(() => {
    window.stop = globalThis.reveal.followSidebarWorkspace("host:target");
  });
  await checkCentered();
  await page.evaluate(() => {
    document.getElementById("before").style.height = "2900px";
  });
  await checkCentered();
  await page.evaluate(() => {
    document.getElementById("before").style.height = "50px";
  });
  await checkCentered();
  await page.evaluate(() => {
    document.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    document.getElementById("sidebar").scrollTop = 1200;
    document.getElementById("before").style.height = "600px";
  });
  await settle();
  assert.equal((await measure()).top, 1200);
  checks++;
  await page.evaluate(() => {
    window.stop();
    window.stop = globalThis.reveal.followSidebarWorkspace("host:target");
  });
  await checkCentered();
  await page.evaluate(() => {
    document.getElementById("target").remove();
    window.stop();
    window.stop = globalThis.reveal.followSidebarWorkspace("host:target");
    document.getElementById("sidebar").scrollTop = 0;
  });
  await page.waitForTimeout(2100);
  await page.evaluate(() => {
    const row = document.createElement("div");
    row.id = "target";
    row.className = "row";
    row.dataset.testid = "sidebar-workspace-row-host:target";
    document.getElementById("before").after(row);
  });
  await checkCentered();
  for (const event of ["pointerdown", "keydown"]) {
    await page.evaluate((event) => {
      document.dispatchEvent(new Event(event, { bubbles: true }));
      document.getElementById("sidebar").scrollTop = 1200;
      document.getElementById("before").style.height = "700px";
    }, event);
    await settle();
    assert.equal((await measure()).top, 1200);
    checks++;
    await page.evaluate(() => {
      window.stop();
      window.stop = globalThis.reveal.followSidebarWorkspace("host:target");
    });
    await checkCentered();
  }
  await page.evaluate(() => {
    window.stop();
    document.getElementById("sidebar").scrollTop = 0;
    document.getElementById("before").style.height = "1400px";
  });
  await settle();
  assert.equal((await measure()).top, 0);
  checks++;
  console.log(
    JSON.stringify({ checks, passed: true, browser: "Chromium", actualScrollLayout: true }),
  );
} finally {
  await browser.close();
}
