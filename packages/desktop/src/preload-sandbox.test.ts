import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PASEO_BROWSER_PROFILE_PARTITION } from "./features/browser-profile.js";

// The preload runs inside Electron's sandbox and is tsc-compiled (not bundled), so at
// runtime it may only load Electron's sandbox allowlist. Any other module (local or
// third-party) emits a require() that the sandbox rejects synchronously, aborting the
// preload before contextBridge.exposeInMainWorld runs and leaving window.paseoDesktop
// undefined. That regression (0.1.108, #2103) is what this test guards against.
const SANDBOX_ALLOWLIST = new Set(["electron"]);

const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.ts");

// Collect every module specifier that survives to emitted JavaScript as a runtime load.
// Type-only imports/exports are erased by tsc and are therefore ignored.
function runtimeModuleSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "preload.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const specifiers: string[] = [];

  const record = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };

  const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
    const clause = node.importClause;
    if (!clause) {
      // Side-effect import: `import "./x.js"` — always a runtime load.
      return false;
    }
    if (clause.isTypeOnly) {
      return true;
    }
    const bindings = clause.namedBindings;
    // `import { type A, type B } from "x"` erases entirely; a default or namespace
    // binding, or any value-named binding, keeps the module at runtime.
    return (
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node)) {
        record(node.moduleSpecifier);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

describe("preload sandbox safety", () => {
  it("namespaces dedicated-window attachment writes and GC without changing other IPCs", async () => {
    const source = readFileSync(preloadPath, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const scope = {
      windowId: "11111111-1111-4111-8111-111111111111",
      serverId: "host",
      projectId: "project",
      projectName: "Project",
      directory: "/project",
    };
    const calls: unknown[][] = [];
    const exposed: {
      invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
    } = {};
    const electron = {
      contextBridge: {
        exposeInMainWorld(_name: string, value: typeof exposed) {
          Object.assign(exposed, value);
        },
      },
      ipcRenderer: {
        invoke(...args: unknown[]) {
          calls.push(args);
          return Promise.resolve();
        },
      },
      webUtils: {},
    };
    const context = {
      exports: {},
      require: (name: string) => {
        if (name !== "electron") throw Error("Sandbox import");
        return electron;
      },
      process: {
        argv: [`--paseo-project-window=${encodeURIComponent(JSON.stringify(scope))}`],
        platform: "win32",
      },
    };
    runInNewContext(compiled, context);
    if (!exposed.invoke) throw Error("Missing preload bridge");
    await exposed.invoke("write_attachment_bytes", { attachmentId: "image", bytes: [1, 2] });
    await exposed.invoke("garbage_collect_attachment_files", { referencedIds: ["image"] });
    await exposed.invoke("unrelated", { id: "image" });
    expect(JSON.parse(JSON.stringify(calls))).toEqual([
      [
        "paseo:invoke",
        "write_attachment_bytes",
        { attachmentId: `pw_${scope.windowId}__image`, bytes: [1, 2] },
      ],
      [
        "paseo:invoke",
        "garbage_collect_attachment_files",
        { referencedIds: [`pw_${scope.windowId}__image`], projectWindowId: scope.windowId },
      ],
      ["paseo:invoke", "unrelated", { id: "image" }],
    ]);
    calls.length = 0;
    runInNewContext(compiled, { ...context, process: { ...context.process, argv: [] } });
    await exposed.invoke("write_attachment_bytes", { attachmentId: "image", bytes: [1] });
    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual([
      "paseo:invoke",
      "write_attachment_bytes",
      { attachmentId: "image", bytes: [1] },
    ]);
  });
  it("only loads Electron's sandbox allowlist at runtime", () => {
    const source = readFileSync(preloadPath, "utf8");
    const disallowed = runtimeModuleSpecifiers(source).filter(
      (specifier) => !SANDBOX_ALLOWLIST.has(specifier),
    );
    expect(disallowed).toEqual([]);
  });

  it("inlines the browser profile partition instead of importing it", () => {
    const source = readFileSync(preloadPath, "utf8");
    const match = source.match(/const\s+PASEO_BROWSER_PROFILE_PARTITION\s*=\s*"([^"]+)"/);
    expect(
      match,
      "PASEO_BROWSER_PROFILE_PARTITION not found as a double-quoted string literal in preload.ts",
    ).not.toBeNull();
    expect(match![1]).toBe(PASEO_BROWSER_PROFILE_PARTITION);
  });
});
