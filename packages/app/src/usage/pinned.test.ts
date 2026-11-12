import { describe, expect, it } from "vitest";
import type { UsagePreferences } from "./preferences";
import {
  choosePinnedUsageLayout,
  pinnedUsageWindowName,
  resolvePinnedUsage,
  resolveProviderPinnedUsage,
  type PinnedUsageProvider,
  type PinnedUsageSource,
  type PinnedUsageWindow,
} from "./pinned";
import type { UsageReportEntry, UsageWindow } from "./types";

it("keeps legacy Windows pins selected without displaying each account twice", () => {
  const canonical = report({
    sourceId: "claude",
    sourceLabel: "Claude",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 20 }],
  });
  const legacy = { ...canonical, sourceId: "claude-windows", id: "claude-windows:default" };
  const legacyPreferences: UsagePreferences = {
    displayAs: "used",
    serverId: "host",
    pins: [{ sourceId: "claude-windows", windowId: "weekly" }],
  };
  expect(resolvePinnedUsage([legacy, canonical], legacyPreferences)).toHaveLength(1);
  expect(resolvePinnedUsage([canonical], legacyPreferences)).toHaveLength(1);
  expect(legacyPreferences.pins).toEqual([{ sourceId: "claude-windows", windowId: "weekly" }]);
});

function report(input: {
  sourceId: string;
  sourceLabel: string;
  account?: string;
  icon?: string;
  windows: UsageWindow[];
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:${input.account ?? "default"}`,
    account: input.account ? { label: input.account } : {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    ...(input.icon ? { icon: input.icon } : {}),
    report: { status: "available", windows: input.windows },
  };
}

const claude = report({
  sourceId: "claude",
  sourceLabel: "Claude",
  icon: "<svg/>",
  windows: [
    { id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 31 },
    { id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 80 },
  ],
});
const codex = report({
  sourceId: "codex",
  sourceLabel: "Codex",
  windows: [{ id: "weekly", label: "Weekly", remainingPct: 88 }],
});

it("shares a provider icon while retaining separate account meters and avoiding legacy duplicates", () => {
  const first = report({
    sourceId: "claude",
    sourceLabel: "Claude",
    account: "one",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 100 }],
  });
  const second = report({
    sourceId: "claude",
    sourceLabel: "Claude",
    account: "two",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 0 }],
  });
  const duplicate = { ...first, sourceId: "claude-windows", id: "claude-windows:one" };
  const result = resolveProviderPinnedUsage([first, second, duplicate, codex], preferences(null));
  expect(result.map((source) => source.key)).toEqual(["claude", "codex"]);
  expect(result[0].windows).toHaveLength(2);
  expect(result[0].windows.map((window) => window.percent)).toEqual([100, 0]);
  expect(result[0].windows.map((window) => window.label)).toEqual([
    "Claude (one) Weekly 100% used",
    "Claude (two) Weekly 0% used",
  ]);
  expect(
    resolveProviderPinnedUsage([first, second], preferences(null, "remaining"))[0].windows.map(
      (window) => window.percent,
    ),
  ).toEqual([0, 100]);
  expect(resolveProviderPinnedUsage([first], preferences(null))[0].windows[0].percent).toBe(100);
});

function windows(reports: UsageReportEntry[], prefs: UsagePreferences): PinnedUsageWindow[] {
  return resolvePinnedUsage(reports, prefs).flatMap((source) => source.windows);
}

function preferences(
  pinned: UsagePreferences["pins"],
  displayAs: UsagePreferences["displayAs"] = "used",
): UsagePreferences {
  return { displayAs, pins: pinned, serverId: null };
}

describe("choosePinnedUsageLayout", () => {
  const widths = { labelsWidth: 200, percentsWidth: 120, windowCount: 2 };

  it("shows meters only when every window's meter fits beside the labels", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: 240 })).toBe("meters");
    expect(choosePinnedUsageLayout({ ...widths, available: 239 })).toBe("labels");
  });

  it("drops the labels before it lets the line overflow", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: 199 })).toBe("percents");
  });

  it("shows labels until the widths are measured", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: null })).toBe("labels");
    expect(choosePinnedUsageLayout({ ...widths, available: 999, labelsWidth: null })).toBe(
      "labels",
    );
  });
});

describe("resolvePinnedUsage", () => {
  it("defaults to source-wide pins collected from each account", () => {
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [
        { id: "empty", label: "Empty" },
        { id: "weekly", label: "Weekly", usedPct: 90 },
      ],
    });
    const empty = report({
      sourceId: "empty",
      sourceLabel: "Empty",
      windows: [{ id: "empty", label: "Empty" }],
    });
    expect(
      windows([claude, codex, work, empty], preferences(null)).map((item) => [
        item.key,
        item.percentText,
      ]),
    ).toEqual([
      ["claude:default/five-hour", "31%"],
      ["claude:default/weekly", "80%"],
      ["claude:work/weekly", "90%"],
      ["codex:default/weekly", "12%"],
    ]);
  });

  it("pins replace defaults, and removing all pins restores defaults", () => {
    const reports = [claude, codex];
    expect(
      windows(reports, preferences([{ sourceId: "claude", windowId: "weekly" }])).map(
        (item) => item.key,
      ),
    ).toEqual(["claude:default/weekly"]);
    expect(windows(reports, preferences(null)).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "codex:default/weekly",
    ]);
  });

  it("groups pinned windows by source in report order, not pin order", () => {
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 90 }],
    });
    const sources = resolvePinnedUsage(
      [claude, codex, work],
      preferences([
        { sourceId: "claude", windowId: "weekly" },
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "claude", windowId: "five-hour" },
      ]),
    );

    const windowKeys = (source: PinnedUsageSource) => source.windows.map((window) => window.key);
    expect(sources.map((source) => [source.key, windowKeys(source)])).toEqual([
      ["claude:default", ["claude:default/five-hour", "claude:default/weekly"]],
      ["claude:work", ["claude:work/weekly"]],
      ["codex:default", ["codex:default/weekly"]],
    ]);
    expect(sources[0]).toEqual({
      key: "claude:default",
      icon: "<svg/>",
      windows: [
        {
          key: "claude:default/five-hour",
          label: "Claude Session 31% used",
          shortLabel: "5h",
          percent: 31,
          percentText: "31%",
          tone: "default",
        },
        {
          key: "claude:default/weekly",
          label: "Claude Weekly 80% used",
          shortLabel: "wk",
          percent: 80,
          percentText: "80%",
          tone: "warning",
        },
      ],
    });
  });

  it("names a window by its label when the source gives no short label", () => {
    const items = windows([codex], preferences([{ sourceId: "codex", windowId: "weekly" }]));

    expect(items.map((item) => item.shortLabel)).toEqual(["Weekly"]);
  });

  it("defaults to every window the source marks as summary, when it marks any", () => {
    const marked = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      windows: [
        { id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 31, summary: true },
        { id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 80, summary: true },
        { id: "weekly-fable", label: "Weekly · Fable", usedPct: 8 },
      ],
    });

    expect(windows([marked, codex], preferences(null)).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "claude:default/weekly",
      "codex:default/weekly",
    ]);
  });

  it("keeps an empty short label empty, for a percent that needs no name", () => {
    const opencode = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode Go",
      windows: [{ id: "rolling", label: "Rolling", shortLabel: "", usedPct: 21 }],
    });
    const items = windows([opencode], preferences(null));

    expect(items.map((item) => item.shortLabel)).toEqual([""]);
  });

  it("formats the share left when the user reads usage as remaining", () => {
    const items = windows(
      [claude, codex],
      preferences(
        [
          { sourceId: "claude", windowId: "five-hour" },
          { sourceId: "codex", windowId: "weekly" },
        ],
        "remaining",
      ),
    );

    expect(items.map((item) => item.percentText)).toEqual(["69%", "88%"]);
    expect(items.map((item) => item.label)).toEqual([
      "Claude Session 69% left",
      "Codex Weekly 88% left",
    ]);
  });

  it("leaves out a pinned window that no report has, or that reports no percent", () => {
    const noPercent = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode",
      windows: [{ id: "monthly", label: "Monthly" }],
    });
    const items = windows(
      [claude, noPercent],
      preferences([
        { sourceId: "claude", windowId: "monthly" },
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "opencode", windowId: "monthly" },
      ]),
    );

    expect(items).toEqual([]);
  });

  it("shows a pin once per account of the source", () => {
    const personal = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "personal",
      windows: [{ id: "five-hour", label: "5-hour", usedPct: 10 }],
    });
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "five-hour", label: "5-hour", usedPct: 90 }],
    });
    const items = windows(
      [personal, codex, work],
      preferences([{ sourceId: "claude", windowId: "five-hour" }]),
    );

    expect(items.map((item) => [item.label, item.percentText])).toEqual([
      ["Claude (personal) 5-hour 10% used", "10%"],
      ["Claude (work) 5-hour 90% used", "90%"],
    ]);
  });
});

it("keeps unavailable and error reports out of the sidebar summary even with retained data", () => {
  if (claude.report.status !== "available" || codex.report.status !== "available")
    throw new Error("fixtures must be available");
  const expired: UsageReportEntry = {
    ...claude,
    lastSuccessful: { fetchedAt: claude.fetchedAt, report: claude.report },
    report: {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-10-01T00:00:00.000Z", refreshedBy: "claude" },
    },
  };
  const failed: UsageReportEntry = {
    ...codex,
    lastSuccessful: { fetchedAt: codex.fetchedAt, report: codex.report },
    report: { status: "error", error: "Store deleted" },
  };
  expect(resolvePinnedUsage([expired, failed], preferences(null))).toEqual([]);
});

describe("resolveProviderPinnedUsage hover card", () => {
  // Clock times follow the machine's 12/24-hour preference, so each expectation names both.
  const twelveHour = ["h11", "h12"].includes(
    new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle ?? "",
  );
  const clock = (twelve: string, twentyFour: string) => (twelveHour ? twelve : twentyFour);
  const local = (month: number, day: number, hour: number, minute: number, second = 0) =>
    new Date(2026, month - 1, day, hour, minute, second).toISOString();
  const now = new Date(2026, 10, 11, 11, 0).getTime();

  const firstClaude = report({
    sourceId: "claude",
    sourceLabel: "Claude",
    account: "claudecodelover@gmail.com",
    icon: "<svg/>",
    windows: [
      {
        id: "five_hour",
        label: "Session",
        shortLabel: "5h",
        usedPct: 12,
        resetsAt: local(11, 11, 15, 30),
      },
      {
        id: "weekly",
        label: "Weekly",
        shortLabel: "wk",
        usedPct: 75,
        resetsAt: local(11, 14, 13, 0),
      },
      {
        id: "weekly_model_fable",
        label: "Weekly · Fable",
        shortLabel: "wk Fable",
        usedPct: 95,
        resetsAt: new Date(2027, 0, 2, 9, 5).toISOString(),
      },
    ],
  });
  const secondClaude = report({
    sourceId: "claude",
    sourceLabel: "Claude",
    account: "claudecodelover2@gmail.com",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 60, resetsAt: local(11, 17, 15, 0) }],
  });
  const codexAccount = report({
    sourceId: "codex",
    sourceLabel: "Codex",
    windows: [
      { id: "weekly", label: "Weekly", remainingPct: 52, resetsAt: local(11, 15, 10, 36, 39) },
      { id: "code_review:weekly", label: "Code review · Weekly", usedPct: 10 },
    ],
  });
  const pins: UsagePreferences["pins"] = [
    { sourceId: "claude", windowId: "five_hour" },
    { sourceId: "claude", windowId: "weekly" },
    { sourceId: "claude", windowId: "weekly_model_fable" },
    { sourceId: "codex", windowId: "weekly" },
    { sourceId: "codex", windowId: "code_review:weekly" },
  ];
  const reports = [firstClaude, codexAccount, secondClaude];

  const rows = (provider: PinnedUsageProvider) =>
    provider.accounts.map((account) => [
      account.label,
      account.windows.map((window) => [
        window.detail.name,
        `${window.percentText} ${window.detail.percentMeaning}`,
        window.tone,
        window.detail.reset && `${window.detail.reset.at} · ${window.detail.reset.relative}`,
      ]),
    ]);

  it("groups each provider's accounts under its name, a row per window", () => {
    const providers = resolveProviderPinnedUsage(reports, preferences(pins), now);

    expect(providers.map((provider) => [provider.key, provider.label, provider.icon])).toEqual([
      ["claude", "Claude", "<svg/>"],
      ["codex", "Codex", null],
    ]);
    expect(rows(providers[0])).toEqual([
      [
        "claudecodelover@gmail.com",
        [
          ["5시간", "12% 사용", "default", `11. 11. (수) ${clock("오후 03:30", "15:30")} · 4h`],
          ["주간", "75% 사용", "warning", `11. 14. (토) ${clock("오후 01:00", "13:00")} · D-3`],
          [
            "주간 · Fable",
            "95% 사용",
            "danger",
            `2027. 1. 2. (토) ${clock("오전 09:05", "09:05")} · D-51`,
          ],
        ],
      ],
      [
        "claudecodelover2@gmail.com",
        [["주간", "60% 사용", "default", `11. 17. (화) ${clock("오후 03:00", "15:00")} · D-6`]],
      ],
    ]);
    expect(rows(providers[1])).toEqual([
      [
        null,
        [
          ["주간", "48% 사용", "default", `11. 15. (일) ${clock("오전 10:36", "10:36")} · D-3`],
          ["주간 · Code review", "10% 사용", "default", null],
        ],
      ],
    ]);
  });

  it("names an unnamed account only when its provider lists another account", () => {
    const unnamedClaude = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 5, resetsAt: local(11, 12, 9, 0) }],
    });
    const providers = resolveProviderPinnedUsage(
      [firstClaude, unnamedClaude, codexAccount],
      preferences(pins),
      now,
    );

    const accountLabels = (provider: PinnedUsageProvider) =>
      provider.accounts.map((account) => account.label);
    expect(providers.map(accountLabels)).toEqual([
      ["claudecodelover@gmail.com", "이름을 알 수 없는 계정"],
      [null],
    ]);
  });

  it("reads a reset that has come as passed", () => {
    const passed = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 5, resetsAt: local(11, 11, 9, 0) }],
    });
    const [provider] = resolveProviderPinnedUsage([passed], preferences(pins), now);

    expect(provider.windows[0].detail.reset).toEqual({
      at: `11. 11. (수) ${clock("오전 09:00", "09:00")}`,
      compactAt: "11/11 09:00",
      relative: "지남",
    });
  });

  it("keeps the meters' flat window list in the same order as the card's rows", () => {
    const [claudeProvider] = resolveProviderPinnedUsage(reports, preferences(pins), now);

    expect(claudeProvider.windows).toEqual(
      claudeProvider.accounts.flatMap((account) => account.windows),
    );
  });

  it("reads the share left when the user reads usage as remaining", () => {
    const [claudeProvider, codexProvider] = resolveProviderPinnedUsage(
      reports,
      preferences(pins, "remaining"),
      now,
    );

    const percents = (provider: PinnedUsageProvider) =>
      provider.windows.map((window) => `${window.percentText} ${window.detail.percentMeaning}`);
    expect(percents(claudeProvider)).toEqual(["88% 남음", "25% 남음", "5% 남음", "40% 남음"]);
    expect(percents(codexProvider)).toEqual(["52% 남음", "90% 남음"]);
  });

  it("names the reset time without seconds in each window's accessible label", () => {
    const [, codexProvider] = resolveProviderPinnedUsage(reports, preferences(pins), now);

    expect(codexProvider.windows.map((window) => window.label)).toEqual([
      `Codex Weekly 48% used · 초기화 11. 15. (일) ${clock("오전 10:36", "10:36")}`,
      "Codex Code review · Weekly 10% used",
    ]);
  });
});

describe("pinnedUsageWindowName", () => {
  it.each([
    [{ id: "five_hour", label: "Session" }, "5시간"],
    [{ id: "weekly", label: "Weekly" }, "주간"],
    [{ id: "weekly_model_fable", label: "Weekly · Fable" }, "주간 · Fable"],
    [{ id: "weekly_surface_code", label: "Weekly · Code" }, "주간 · Code"],
    [{ id: "weekly_model_opus", label: "Opus" }, "Opus"],
    [{ id: "code_review:weekly", label: "Code review · Weekly" }, "주간 · Code review"],
    [
      { id: "limit:GPT-5.3-Codex-Spark:five_hour", label: "GPT-5.3-Codex-Spark · 5-hour" },
      "5시간 · GPT-5.3-Codex-Spark",
    ],
    [{ id: "code_review:86400s", label: "Code review · 1-day" }, "Code review · 1-day"],
    [{ id: "code_review:weekly", label: "Code review" }, "Code review"],
    [{ id: "monthly", label: "Monthly" }, "Monthly"],
    [{ id: "constructor", label: "Constructor" }, "Constructor"],
  ])("names %o %s", (window, expected) => {
    expect(pinnedUsageWindowName(window)).toBe(expected);
  });
});
