import { expect, it } from "vitest";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import contribute from "./index.server.js";
import { inputSchema } from "./shared/input.js";
import {
  CLEARED,
  DAEMON_LOGIN,
  FRESH_INSTALL,
  NO_LOGIN,
  login,
  profileApi,
  providers,
  serviceFor,
  windowsHost,
} from "./test/windows-host.js";

const FIRST = "C:/fixture/provider-profiles/first";
const SECOND = "C:/fixture/provider-profiles/second";

/** Registers the plugin on this host and looks its usage sources up by id. */
function sourcesOn(lookup: ReturnType<typeof windowsHost>) {
  const sources = new Map<string, UsageSourceRegistration>();
  contribute(
    {
      handle() {},
      registerUsageSource(source) {
        sources.set(source.id, source);
      },
    },
    { lookup, fetchApi: profileApi },
  );
  return (id: string) => {
    const source = sources.get(id);
    if (!source) throw new Error(`Usage source ${id} was not registered`);
    return source;
  };
}

async function listedServices(source: UsageSourceRegistration) {
  const accounts = await source.discover({ kind: "global" });
  return accounts.map((account) => {
    const { route } = inputSchema.parse(account.input);
    return route.store === "windows-credman" ? route.service : route.store;
  });
}

it("neither Claude source lists the daemon's empty login that no provider uses", async () => {
  const source = sourcesOn(
    windowsHost(
      providers({
        claude: { env: { CLAUDE_CONFIG_DIR: FIRST } },
        second: { extends: "claude", env: { CLAUDE_CONFIG_DIR: SECOND } },
      }),
      {
        [DAEMON_LOGIN]: NO_LOGIN,
        [serviceFor(FIRST)]: login("isolated-first"),
        [serviceFor(SECOND)]: login("isolated-second"),
      },
    ),
  );
  const providerLogins = [serviceFor(FIRST), serviceFor(SECOND)];
  expect(await listedServices(source("claude"))).toEqual(providerLogins);
  expect(await listedServices(source("claude-windows"))).toEqual(providerLogins);
});

it("both Claude sources report the daemon's empty login on a fresh install", async () => {
  const source = sourcesOn(windowsHost(FRESH_INSTALL, { [DAEMON_LOGIN]: NO_LOGIN }));
  const daemonLogin = { route: { store: "windows-credman", service: DAEMON_LOGIN } };
  for (const id of ["claude", "claude-windows"]) {
    expect(await listedServices(source(id))).toEqual([DAEMON_LOGIN]);
    expect(await source(id).fetch(daemonLogin)).toEqual(CLEARED);
  }
});
