const sidebarSelector =
  '[data-testid="sidebar-project-workspace-list-scroll"],[data-testid="sidebar-status-list-scroll"]';

export function followSidebarWorkspace(workspaceKey: string): () => void {
  const testId = `sidebar-workspace-row-${workspaceKey}`;
  let frame = 0;
  let stopped = false;
  let observedSidebar: HTMLElement | null = null;
  const resize = new ResizeObserver(schedule);
  const mutation = new MutationObserver(schedule);

  function reveal(): void {
    frame = 0;
    if (stopped) return;
    const sidebar = Array.from(document.querySelectorAll<HTMLElement>(sidebarSelector)).find(
      (element) => element.clientHeight > 0 && element.getBoundingClientRect().width > 0,
    );
    if (!sidebar) return;
    if (observedSidebar !== sidebar) {
      observedSidebar = sidebar;
      mutation.disconnect();
      mutation.observe(sidebar.parentElement ?? sidebar, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      resize.disconnect();
      resize.observe(sidebar);
      if (sidebar.firstElementChild) resize.observe(sidebar.firstElementChild);
    }
    const row = Array.from(
      sidebar.querySelectorAll<HTMLElement>('[data-testid^="sidebar-workspace-row-"]'),
    ).find((element) => element.dataset.testid === testId && element.clientHeight > 0);
    if (!row) return;
    const viewport = sidebar.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const top = Math.max(viewport.top + sidebar.clientTop, 0);
    const bottom = Math.min(top + sidebar.clientHeight, window.innerHeight);
    if (bounds.top >= top + 12 && bounds.bottom <= bottom - 12) return;
    sidebar.scrollTop += (bounds.top + bounds.bottom - top - bottom) / 2;
  }

  function schedule(): void {
    if (!stopped && !frame) frame = requestAnimationFrame(reveal);
  }

  function stop(): void {
    stopped = true;
    cancelAnimationFrame(frame);
    mutation.disconnect();
    resize.disconnect();
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("wheel", stop, true);
    document.removeEventListener("keydown", stop, true);
  }

  mutation.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("wheel", stop, { capture: true, passive: true });
  document.addEventListener("keydown", stop, true);
  schedule();
  return stop;
}
