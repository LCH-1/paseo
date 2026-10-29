import { join, resolve } from "node:path";
import type { UsageAccount } from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

function pathKey(path: string) {
  return resolve(path).normalize("NFC").toLowerCase();
}

export function selectWindowsAccounts(
  accounts: UsageAccount[],
  configuredHomes: string[],
  primaryHome: string,
) {
  const primaryPath = pathKey(join(primaryHome, ".credentials.json"));
  const extraPaths = new Set(
    configuredHomes
      .filter(Boolean)
      .map((home) => pathKey(join(home, ".credentials.json")))
      .filter((path) => path !== primaryPath),
  );
  return accounts.filter((account) => {
    const { route } = account.input as UsageInput;
    return (
      route.store === "windows-credman" ||
      (route.store === "claude" && extraPaths.has(pathKey(route.path)))
    );
  });
}
