import { Portal, PortalHost } from "@gorhom/portal";
import type { ReactNode } from "react";

// The focused desktop workspace renders its header into the left sidebar so its tab rows can
// sit at the window top, like a terminal.
const WORKSPACE_SIDEBAR_HEADER_HOST = "workspace-sidebar-header";

export function WorkspaceSidebarHeaderHost() {
  return <PortalHost name={WORKSPACE_SIDEBAR_HEADER_HOST} />;
}

export function WorkspaceSidebarHeaderPortal({ children }: { children: ReactNode }) {
  return <Portal hostName={WORKSPACE_SIDEBAR_HEADER_HOST}>{children}</Portal>;
}
