import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface WorkspaceTabDescriptor {
  groupDraft?: import("@/workspace-tabs/new-workspace-tabs").NewWorkspaceTabEntry;
  groupSource?: { serverId: string; workspaceId: string; tabId: string };
  key: string;
  tabId: string;
  kind: WorkspaceTabTarget["kind"];
  target: WorkspaceTabTarget;
  state?: import("@getpaseo/protocol/agent-types").JsonValue;
}
