import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { LiveFileSnapshot } from "../live-file/model";
import { describe, expect, it } from "vitest";
import {
  FilePreviewLifecycleModel,
  type FilePanePreview,
  type FilePreviewLifecycleSnapshot,
} from "./model";

function previewFile(content: string) {
  return {
    kind: "text" as const,
    path: "file.ts",
    size: 7,
    encoding: "utf-8" as const,
    hasBom: false,
    modifiedAt: "2026-08-20T00:00:00.000Z",
    content,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function file(revision = "revision-1", path = "file.ts"): FileReadResult {
  return {
    bytes: new TextEncoder().encode("preview"),
    mime: "text/plain",
    size: 7,
    path,
    kind: "text",
    modifiedAt: "2026-08-20T00:00:00.000Z",
    revision,
  };
}

function pending(): LiveFileSnapshot {
  return { observation: null, read: { status: "pending", requested: false } };
}

function completed(rawFile: FileReadResult): LiveFileSnapshot {
  return {
    observation: {
      status: "ready",
      file: rawFile,
      version: {
        status: "ready",
        cwd: "/workspace",
        path: rawFile.path,
        size: rawFile.size,
        modifiedAt: rawFile.modifiedAt,
        revision: rawFile.revision,
      },
    },
    read: { status: "idle" },
  };
}

function source(
  targetKey: string,
  snapshot: LiveFileSnapshot,
): {
  targetKey: string;
  liveFileSnapshot: LiveFileSnapshot;
} {
  return { targetKey, liveFileSnapshot: snapshot };
}

describe("FilePreviewLifecycleModel", () => {
  it("represents pending raw reads, preparation, ready previews, unsupported files, and conversion failures", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const third = deferred<FilePanePreview | null>();
    const preparations = [first, second, third];
    const model = new FilePreviewLifecycleModel(() => preparations.shift()!.promise);
    const preview: FilePanePreview = {
      file: previewFile("preview"),
      imageAttachment: null,
    };

    model.setSource(source("/workspace:file.ts", pending()));
    expect(model.getSnapshot()).toEqual({ status: "read_pending" });

    model.setSource(source("/workspace:file.ts", completed(file("one"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    first.resolve(preview);
    await expectSnapshot(model, { status: "ready", preview });

    model.setSource(source("/workspace:file.ts", pending()));
    expect(model.getSnapshot()).toEqual({ status: "read_pending", preview });

    model.setSource(
      source("/workspace:file.ts", {
        observation: {
          status: "error",
          cwd: "/workspace",
          path: "file.ts",
          error: "Requested path is not a file",
        },
        read: { status: "pending", requested: true },
      }),
    );
    expect(model.getSnapshot()).toEqual({ status: "read_pending", preview });

    model.setSource(source("/workspace:file.ts", completed(file("two"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing", preview });
    second.resolve(null);
    await expectSnapshot(model, { status: "unsupported" });

    model.setSource(source("/workspace:file.ts", completed(file("three"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    third.reject(new Error("attachment failed"));
    await expectSnapshot(model, { status: "error", message: "attachment failed" });
  });

  it("does not publish a stale conversion after retargeting", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const model = new FilePreviewLifecycleModel((rawFile) =>
      rawFile.revision === "one" ? first.promise : second.promise,
    );
    const nextPreview: FilePanePreview = {
      file: previewFile("two"),
      imageAttachment: null,
    };

    model.setSource(source("/workspace:file.ts", completed(file("one"))));
    model.setSource(source("/workspace:second.ts", completed(file("two", "second.ts"))));
    first.resolve({ file: previewFile("one"), imageAttachment: null });
    await Promise.resolve();
    expect(model.getSnapshot()).toEqual({ status: "preparing" });

    second.resolve(nextPreview);
    await expectSnapshot(model, { status: "ready", preview: nextPreview });
  });

  it("retries a failed preparation after rereading the same unchanged file", async () => {
    const retry = deferred<FilePanePreview | null>();
    let preparations = 0;
    const model = new FilePreviewLifecycleModel(() => {
      preparations += 1;
      if (preparations === 1) return Promise.reject(new Error("attachment failed"));
      return retry.promise;
    });
    const rawFile = file();
    const ready = completed(rawFile);
    const targetKey = "/workspace:file.ts";
    const preview: FilePanePreview = {
      file: previewFile("preview"),
      imageAttachment: null,
    };

    model.setSource(source(targetKey, ready));
    await expectSnapshot(model, { status: "error", message: "attachment failed" });
    model.setSource(source(targetKey, { ...ready, read: { status: "pending", requested: true } }));
    expect(preparations).toBe(1);

    model.setSource(source(targetKey, completed(rawFile)));
    expect(preparations).toBe(2);
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    retry.resolve(preview);
    await expectSnapshot(model, { status: "ready", preview });
  });

  it("does not duplicate pending or successful preparation during an unchanged refresh", async () => {
    const preparation = deferred<FilePanePreview | null>();
    let preparations = 0;
    const model = new FilePreviewLifecycleModel(() => {
      preparations += 1;
      return preparation.promise;
    });
    const rawFile = file();
    const targetKey = "/workspace:file.ts";
    const ready = completed(rawFile);
    const refreshing = { ...ready, read: { status: "pending" as const, requested: true } };
    const preview: FilePanePreview = {
      file: previewFile("preview"),
      imageAttachment: null,
    };

    model.setSource(source(targetKey, ready));
    model.setSource(source(targetKey, refreshing));
    model.setSource(source(targetKey, completed(rawFile)));
    expect(preparations).toBe(1);
    preparation.resolve(preview);
    await expectSnapshot(model, { status: "ready", preview });

    const snapshot = model.getSnapshot();
    model.setSource(source(targetKey, refreshing));
    model.setSource(source(targetKey, completed(rawFile)));
    expect(preparations).toBe(1);
    expect(model.getSnapshot()).toBe(snapshot);
  });

  it("ignores an older preparation failure after a newer revision is ready", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const model = new FilePreviewLifecycleModel((rawFile) =>
      rawFile.revision === "one" ? first.promise : second.promise,
    );
    const preview: FilePanePreview = {
      file: previewFile("newer revision"),
      imageAttachment: null,
    };
    const targetKey = "/workspace:file.ts";

    model.setSource(source(targetKey, completed(file("one"))));
    model.setSource(source(targetKey, completed(file("two"))));
    second.resolve(preview);
    await expectSnapshot(model, { status: "ready", preview });
    const snapshot = model.getSnapshot();

    first.reject(new Error("stale attachment failed"));
    await expectSnapshot(model, { status: "ready", preview });
    model.setSource(source(targetKey, completed(file("two"))));
    expect(model.getSnapshot()).toBe(snapshot);
  });
});

async function expectSnapshot(
  model: FilePreviewLifecycleModel,
  expected: FilePreviewLifecycleSnapshot,
): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(model.getSnapshot()).toEqual(expected);
}
