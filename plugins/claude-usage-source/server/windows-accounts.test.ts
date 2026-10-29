import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { selectWindowsAccounts } from "./windows-accounts.js";

const primary = "C:/fixture/.claude";
const secondary = "C:/fixture/provider-profiles/secondary";
const account = (key: string, route: object) => ({ key, input: { route } });

test("keeps a configured second account after it uses file authentication", () => {
  const first = account("primary", { store: "windows-credman", service: "primary" });
  const second = account("secondary", {
    store: "claude",
    path: join(secondary, ".credentials.json"),
  });
  assert.deepEqual(selectWindowsAccounts([first, second], [secondary], primary), [first, second]);
});

test("leaves the built-in primary and unrelated login files to their existing sources", () => {
  const accounts = [
    account("primary", { store: "claude", path: join(primary, ".credentials.json") }),
    account("unknown", { store: "claude", path: "C:/other/.credentials.json" }),
    account("pi", { store: "pi", path: join(secondary, ".credentials.json") }),
  ];
  assert.deepEqual(selectWindowsAccounts(accounts, ["", primary, secondary], primary), []);
});

test("matches equivalent Windows profile paths without exposing duplicate default accounts", () => {
  const second = account("secondary", {
    store: "claude",
    path: join(secondary.toUpperCase(), ".credentials.json"),
  });
  assert.deepEqual(selectWindowsAccounts([second], [join(secondary, "./")], primary), [second]);
  assert.deepEqual(selectWindowsAccounts([second], [], primary), []);
});
