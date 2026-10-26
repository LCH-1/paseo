import { create } from "zustand";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export interface SidebarRevealRequest extends ActiveWorkspaceSelection {
  sequence: number;
}

interface SidebarRevealState {
  request: SidebarRevealRequest | null;
  reveal: (selection: ActiveWorkspaceSelection) => void;
}

export const useSidebarRevealStore = create<SidebarRevealState>((set) => ({
  request: null,
  reveal: (selection) =>
    set((state) => ({
      request: { ...selection, sequence: (state.request?.sequence ?? 0) + 1 },
    })),
}));
