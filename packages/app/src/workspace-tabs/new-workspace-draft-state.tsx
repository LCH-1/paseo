import React, {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

interface DraftStateCell<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  setState: Dispatch<SetStateAction<T>>;
}

export interface NewWorkspaceDraftState<T> {
  cells: Map<string, DraftStateCell<T>>;
}

const draftStateStores = new Set<{ delete(draftId: string): void }>();
const DraftContext = createContext<string | null>(null);

export function useNewWorkspaceDraftId(): string | null {
  return useContext(DraftContext);
}

export function createNewWorkspaceDraftState<T>(): NewWorkspaceDraftState<T> {
  const cells = new Map<string, DraftStateCell<T>>();
  draftStateStores.add(cells);
  return { cells };
}

export function clearNewWorkspaceDraftState(draftId: string): void {
  for (const store of draftStateStores) store.delete(draftId);
}

export function NewWorkspaceDraftScope({
  draftId,
  children,
}: {
  draftId: string;
  children: ReactNode;
}) {
  return <DraftContext.Provider value={draftId}>{children}</DraftContext.Provider>;
}

function isStateUpdater<T>(value: SetStateAction<T>): value is (previous: T) => T {
  return typeof value === "function";
}

function createCell<T>(initial: () => T): DraftStateCell<T> {
  let value = initial();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(update) {
      const next = isStateUpdater(update) ? update(value) : update;
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

export function useNewWorkspaceDraftState<T>(
  store: NewWorkspaceDraftState<T>,
  initial: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  const draftId = useContext(DraftContext);
  const [cell] = useState(() => {
    const retained = draftId ? store.cells.get(draftId) : undefined;
    if (retained) return retained;
    const created = createCell(initial);
    if (draftId) store.cells.set(draftId, created);
    return created;
  });
  const value = useSyncExternalStore(cell.subscribe, cell.getSnapshot, cell.getSnapshot);
  const setState = useCallback<Dispatch<SetStateAction<T>>>(
    (update) => cell.setState(update),
    [cell],
  );
  return [value, setState];
}
