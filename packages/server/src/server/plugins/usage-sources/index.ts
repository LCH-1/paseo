import { createHash } from "node:crypto";
import type { AgentUsageSession } from "../../agent/agent-sdk-types.js";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { Logger } from "pino";
import {
  UsageReportSchema,
  type ProviderUsage,
  type UsageReportEntry,
  type UsageProblem,
  type UsageReport,
} from "@getpaseo/protocol/messages";
import { RepeatDigest } from "../../websocket/repeat-digest.js";

export interface UsageSource {
  id: string;
  cacheGroup?: string;
  label: string;
  icon?: string;
  discover(scope: UsageScope): Promise<unknown>;
  fetch(input: unknown): Promise<unknown>;
}

interface Login {
  input: unknown;
  harness: string;
}

interface KnownReport {
  source: UsageSource;
  logins: [Login, ...Login[]];
  label?: string;
}

export interface AgentUsageLookup {
  hasAgent(id: string): boolean;
  usageSession(id: string): AgentUsageSession | null;
}

export interface ListUsageReportsOptions {
  forceRefresh?: boolean;
  reportIds?: string[];
  agentId?: string;
  onReport?: (report: UsageReportEntry) => void;
}

interface AgentReports {
  provider: string;
  model?: string;
  sessionKey: string;
  reports: Map<string, KnownReport>;
}

interface HostDiscovery {
  at: number;
  reports: Map<string, KnownReport>;
  /** A later discovery failed: the accounts stay listed, but the source is asked again. */
  stale?: true;
}

interface RunningHostDiscovery {
  current: Promise<unknown>;
  /** A forced refresh started `current`: the store may hold logins the cache does not. */
  forced: boolean;
  /** Starts once `current` settles, for the forced queries that arrived while it ran. */
  next?: Promise<unknown>;
}

/** Sources that share a cache group read the same logins, so the host asks them together. */
type HostGroup = string | UsageSource;

/**
 * Whether the cache answers a host query. "due": it answers, and the group is renewed behind the
 * answer because its cache window is about to end. "expired": the query waits for a renewal.
 */
type HostGroupState = "fresh" | "due" | "expired";

/** Why a host group was renewed, as logged. */
type RenewalReason = "forced" | Exclude<HostGroupState, "fresh">;

/**
 * "cached": a report inside its cache window is answered from the cache. "forced": fetched again.
 * "renewed": a forced query's report its group renewal is fetching, so that fetch answers it.
 */
type FetchMode = "cached" | "forced" | "renewed";

interface RunningFetch {
  request: Promise<UsageReportEntry>;
  /** Fetches are numbered as they start, so a forced query can tell which began after it. */
  seq: number;
  /** A later forced fetch replaced it: its answer still goes to those who joined it, not the cache. */
  supersede(): void;
}

/**
 * A source call longer than this is named in the log: inside its renewal's line when a host group
 * renewal made it, on a line of its own otherwise. A renewal that fetched nothing is logged at info
 * only when one of its discoveries was this slow.
 */
const SLOW_USAGE_CALL_MS = 500;

/** One discovery or fetch of a source, as logged. Names no account, label or login. */
interface UsageSourceCall {
  sourceId: string;
  phase: "discover" | "fetch";
  scope?: UsageScope["kind"];
  durationMs: number;
  ok: boolean;
}

/** Where a slow call is reported: a renewal collects its own into its one line. */
type SlowCallReport = (call: UsageSourceCall) => void;

/**
 * A report renewed behind a query's answer, such as an agent's report while the app polls the
 * host, is renewed every few minutes with nobody waiting. The first slow renewal of a kind gets a
 * line of its own; the ones after it are summed up in one line for each of these windows.
 */
const BACKGROUND_SLOW_CALL_WINDOW_MS = 3_600_000;

/** A kind of slow background call, as summed up. */
type BackgroundSlowCall = Pick<UsageSourceCall, "sourceId" | "phase" | "ok">;

/** Owns account identity, ordered logins for each account, and the five-minute fetch cache. */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly known = new Map<string, KnownReport>();
  private readonly defaults = new Map<UsageSource, HostDiscovery>();
  private readonly discovering = new Map<HostGroup, RunningHostDiscovery>();
  private readonly byAgent = new Map<string, AgentReports>();
  private readonly cache = new Map<string, { at: number; entry: UsageReportEntry }>();
  private readonly successful = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  private readonly pending = new Map<string, RunningFetch>();
  private fetchSeq = 0;
  /** When the host queries of the last cache window arrived, oldest first; forced ones excluded. */
  private readonly hostQueries: number[] = [];
  private readonly backgroundSlowCalls = new RepeatDigest<BackgroundSlowCall>();
  /** When the current window of `backgroundSlowCalls` opened; unset until a call is noted. */
  private backgroundSlowCallsFrom: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
    private readonly logger: Pick<Logger, "warn"> & Partial<Pick<Logger, "info" | "debug">> = {
      warn: console.warn,
    },
    private readonly agents: AgentUsageLookup = { hasAgent: () => false, usageSession: () => null },
    private readonly deadlineMs = 20_000,
    /**
     * A query in the last part of the cache window, at most this long, is answered from the cache
     * and renews it in the background, so a client polling at least this often never waits for
     * the vendor. No report older than the cache window is ever answered: Aster treats one over
     * six minutes old (five here plus its own minute) as unknown.
     */
    private readonly renewAheadMs = Math.min(60_000, ttlMs / 5),
  ) {}

  register(source: UsageSource): void {
    if (this.sources.has(source.id)) throw new Error(`Duplicate usage source: ${source.id}`);
    this.sources.set(source.id, source);
  }

  unregister(id: string): void {
    const source = this.sources.get(id);
    this.sources.delete(id);
    if (source) {
      this.defaults.delete(source);
      this.discovering.delete(hostGroup(source));
    }
    // Re-discover on the next session query when a source is replaced.
    for (const [agentId, mapping] of this.byAgent) {
      if ([...mapping.reports.values()].some((report) => report.source.id === id))
        this.byAgent.delete(agentId);
    }
    for (const key of this.known.keys()) if (key.startsWith(`${id}:`)) this.known.delete(key);
    for (const key of this.cache.keys()) if (key.startsWith(`${id}:`)) this.cache.delete(key);
    for (const key of this.successful.keys())
      if (key.startsWith(`${id}:`)) this.successful.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith(`${id}:`)) this.pending.delete(key);
    const active = this.activeCacheKeys();
    for (const map of [this.cache, this.successful, this.pending]) {
      for (const key of map.keys()) if (!active.has(key)) map.delete(key);
    }
  }

  async listReports(options: ListUsageReportsOptions = {}): Promise<UsageReportEntry[]> {
    if (options.agentId !== undefined && options.reportIds !== undefined)
      throw new Error("agentId and reportIds cannot be combined");
    // A forced query shares only fetches started after it was made: an earlier one may still use
    // a token that the login change behind the force replaced.
    const askedAfter = this.fetchSeq;
    this.flushBackgroundSlowCalls();
    this.pruneAgents();
    let ids: string[];
    let reports = this.known;
    // A report its host group renews is fetched only by that renewal, right after its discovery.
    let renewedByGroup = new Set<string>();
    if (options.agentId !== undefined) {
      ids = await this.discoverAgent(options.agentId);
      reports = this.byAgent.get(options.agentId)?.reports ?? new Map();
    } else if (options.reportIds !== undefined) {
      ids = options.reportIds;
    } else {
      await this.discoverHost(options.forceRefresh);
      ids = [...this.known.keys()];
      for (const found of this.hostReports()) for (const id of found.keys()) renewedByGroup.add(id);
    }
    const mode = (id: string): FetchMode => {
      if (!options.forceRefresh) return "cached";
      return renewedByGroup.has(id) ? "renewed" : "forced";
    };
    const renewAhead = (id: string) => options.reportIds === undefined && !renewedByGroup.has(id);
    return Promise.all(
      [...new Set(ids)].flatMap((id) => {
        const known = reports.get(id);
        if (!known) return [];
        return [
          this.fetchId(id, known, mode(id), renewAhead(id), askedAfter).then((entry) => {
            options.onReport?.(entry);
            return entry;
          }),
        ];
      }),
    );
  }

  private pruneAgents(): void {
    for (const id of this.byAgent.keys()) {
      if (!this.agents.hasAgent(id)) this.byAgent.delete(id);
    }
    this.mergeKnown();
  }

  private async discoverAgent(agentId: string): Promise<string[]> {
    if (!this.agents.hasAgent(agentId)) throw new Error(`Unknown agent: ${agentId}`);
    const session = this.agents.usageSession(agentId);
    if (!session) {
      this.byAgent.delete(agentId);
      this.mergeKnown();
      return [];
    }
    const previous = this.byAgent.get(agentId);
    const sameScope =
      previous?.sessionKey === session.sessionKey &&
      previous.provider === session.provider &&
      previous.model === session.model;
    if (sameScope) return [...previous.reports.keys()];
    const reports = await this.discover({
      kind: "session",
      provider: session.provider,
      model: session.model,
      env: session.env,
    });
    // A query that finishes after a resume must not publish the previous launch's mapping.
    if (this.agents.usageSession(agentId)?.sessionKey !== session.sessionKey) return [];
    this.byAgent.set(agentId, {
      sessionKey: session.sessionKey,
      provider: session.provider,
      model: session.model,
      reports,
    });
    this.mergeKnown();
    return [...reports.keys()];
  }

  /**
   * Asks each source for the host's accounts. Concurrent queries share one answer, and a source's
   * answer is reused for as long as the fetch cache still serves every report it produced. Near
   * the end of that window a query is still answered from the cache while the group is renewed.
   */
  private async discoverHost(forceRefresh = false): Promise<void> {
    if (!forceRefresh) this.noteHostQuery();
    const groups = new Set([...this.sources.values()].map(hostGroup));
    await Promise.all([...groups].map((group) => this.discoverHostGroup(group, forceRefresh)));
    this.mergeKnown();
  }

  private discoverHostGroup(group: HostGroup, forceRefresh: boolean): Promise<unknown> {
    const sources = [...this.sources.values()].filter((source) => hostGroup(source) === group);
    const running = this.discovering.get(group);
    if (running) {
      if (!forceRefresh) {
        // A forced refresh asked for the logins the store holds now, often because they changed,
        // so a query made while it is under way waits for its answer instead of the cache's.
        const forced = running.next ?? (running.forced ? running.current : undefined);
        if (forced) return forced;
        // A renewal running behind earlier answers is joined only once the cache cannot answer.
        return this.hostGroupState(sources) === "expired" ? running.current : Promise.resolve();
      }
      // The running discovery may have read the login store before this query was made, and its
      // answer would then be reused for the whole cache window. Forced queries that arrive while
      // it runs share one discovery that starts after it.
      running.next ??= running.current.then(() => this.discoverHostGroup(group, true));
      return running.next;
    }
    const state = forceRefresh ? "forced" : this.hostGroupState(sources);
    if (state === "fresh") return Promise.resolve();
    const renewal = this.renewHostGroup(group, sources, state);
    if (state !== "due") return renewal;
    renewal.catch((err: unknown) =>
      this.logger.warn({ group: groupName(group), err }, "Usage source renewal failed"),
    );
    return Promise.resolve();
  }

  /**
   * Discovers a group's accounts again, then fetches its reports again with the logins that
   * discovery just read. The group's reports are fetched together so they share one cache window:
   * a report fetched on its own (a targeted refresh) would otherwise expire apart from the others
   * and cost the group a second discovery in every window. A source that cannot be read renews its
   * group on every query; that alone fetches nothing, so the accounts its siblings named still
   * reach the vendor once per window.
   */
  private renewHostGroup(
    group: HostGroup,
    sources: UsageSource[],
    reason: RenewalReason,
  ): Promise<unknown> {
    const renew = async () => {
      const slowCalls: UsageSourceCall[] = [];
      const report: SlowCallReport = (call) => slowCalls.push(call);
      // Asked before the discovery renews the windows of the sources that answer it.
      const discoveryEnding = this.hostDiscoveryEnding(sources);
      const startedAt = this.now();
      const answered = await Promise.all(
        sources.map((source) => this.rediscoverHostSource(source, report)),
      );
      this.mergeKnown();
      const discoveredAt = this.now();
      // Asked at the instant the fetches below ask each report, so a report due by then brings
      // the rest of its group with it rather than leaving them for a renewal a poll later.
      const windowEnding = discoveryEnding || this.hostReportEnding(sources);
      // A forced renewal's fetches use the logins its discovery just read, so they share no fetch
      // started before it answered; the group's sources still share the fetches they start here.
      const startedAfter = reason === "forced" ? this.fetchSeq : -1;
      const fetches = sources.flatMap((source, index) =>
        this.refetchHostSource(
          source,
          reason === "forced" || (windowEnding && answered[index] === true),
          startedAfter,
          report,
        ),
      );
      if (sources.length > 0)
        void this.logRenewal(
          group,
          reason,
          discoveredAt - startedAt,
          discoveredAt,
          fetches,
          slowCalls,
        );
    };
    const started: RunningHostDiscovery = {
      // Settles after the entry is gone, so a discovery chained on it starts a new one.
      current: renew().finally(() => {
        if (this.discovering.get(group) === started) this.discovering.delete(group);
      }),
      forced: reason === "forced",
    };
    this.discovering.set(group, started);
    return started.current;
  }

  /** Whether the source answered. One that failed or was replaced keeps what it said before. */
  private async rediscoverHostSource(
    source: UsageSource,
    report: SlowCallReport,
  ): Promise<boolean> {
    const reports = await this.discoverSource(source, { kind: "global" }, report);
    if (this.sources.get(source.id) !== source) return false;
    if (reports) {
      // Timed from the answer, like the fetches after it, so the query that started a renewal
      // and those at the same pace after it never find the new window ending under them.
      this.defaults.set(source, { at: this.now(), reports });
      return true;
    }
    // A failed store read does not confirm removal: keep the accounts and ask again.
    const found = this.defaults.get(source);
    if (found) found.stale = true;
    return false;
  }

  /**
   * Starts a renewal's fetches. A forced renewal fetches every report, and so does a source that
   * answered while its group's window is ending, with the logins just named. Otherwise only the
   * reports that are due are fetched: a source whose discovery failed still has its previous
   * logins, and a group renewed only to ask such a source again has no other report to fetch.
   */
  private refetchHostSource(
    source: UsageSource,
    every: boolean,
    startedAfter: number,
    report: SlowCallReport,
  ): Promise<UsageReportEntry>[] {
    const found = this.defaults.get(source);
    if (!found || this.sources.get(source.id) !== source) return [];
    return [...found.reports.keys()].flatMap((id) => {
      const known = this.known.get(id);
      if (!known || (!every && !this.hostReportDue(id))) return [];
      return [this.fetchId(id, known, "forced", false, startedAfter, report)];
    });
  }

  private noteHostQuery(): void {
    const now = this.now();
    while (this.hostQueries.length > 0 && now - this.hostQueries[0]! >= this.ttlMs)
      this.hostQueries.shift();
    if (this.hostQueries.length >= 1024) this.hostQueries.shift();
    this.hostQueries.push(now);
  }

  /**
   * How long before its end a host cache window is renewed: the longest recent gap between host
   * queries, so the next one is still expected inside the window. Renewing a whole minute early
   * for windows polled every few seconds would fetch a fifth more often than the window needs.
   */
  private hostRenewAhead(): number {
    let gap = 0;
    for (let index = 1; index < this.hostQueries.length; index++)
      gap = Math.max(gap, this.hostQueries[index]! - this.hostQueries[index - 1]!);
    return gap > 0 ? Math.min(gap, this.renewAheadMs) : this.renewAheadMs;
  }

  private hostGroupState(sources: UsageSource[]): HostGroupState {
    const renewAt = this.ttlMs - this.hostRenewAhead();
    let state: HostGroupState = "fresh";
    for (const source of sources) {
      const found = this.defaults.get(source);
      if (!found || this.now() - found.at >= this.ttlMs) return "expired";
      if (found.stale || this.now() - found.at >= renewAt) state = "due";
      // A report about to reach the vendor again must use the login its store holds now, so a
      // report is fetched only by a renewal of its group.
      for (const id of found.reports.keys()) {
        const age = this.fetchAge(id);
        if (age === undefined || age >= this.ttlMs) return "expired";
        if (age >= renewAt) state = "due";
      }
    }
    return state;
  }

  /**
   * Whether a discovery that answered is in the last part of its window. It is timed from its
   * answer, so it ends a fetch before the reports it named do, and renewing it renews them too.
   */
  private hostDiscoveryEnding(sources: UsageSource[]): boolean {
    const renewAt = this.ttlMs - this.hostRenewAhead();
    return sources.some((source) => {
      const found = this.defaults.get(source);
      return found !== undefined && !found.stale && this.now() - found.at >= renewAt;
    });
  }

  /** Whether any of a group's reports is due; see `hostReportDue`. */
  private hostReportEnding(sources: UsageSource[]): boolean {
    return sources.some((source) =>
      [...(this.defaults.get(source)?.reports.keys() ?? [])].some((id) => this.hostReportDue(id)),
    );
  }

  /** Whether a report is in its window's last part, or has nothing cached: named anew, or over. */
  private hostReportDue(id: string): boolean {
    const age = this.fetchAge(id);
    return age === undefined || age >= this.ttlMs - this.hostRenewAhead();
  }

  /** How long ago a report was fetched: 0 while a fetch runs, undefined when nothing is cached. */
  private fetchAge(id: string): number | undefined {
    const known = this.known.get(id);
    if (!known) return undefined;
    const cacheKey = cacheIdentity(id, known);
    if (this.pending.has(cacheKey)) return 0;
    const cached = this.cache.get(cacheKey);
    return cached === undefined ? undefined : this.now() - cached.at;
  }

  /**
   * One line per renewal, so the time spent discovering and fetching can be read from the log.
   * Its slow source calls, in the order they finished, ride on the same line rather than adding a
   * line each every five minutes. Most sources list no account on a host, and their quick
   * discoveries would fill the info log; they are logged at debug, and a slow one is still logged
   * at info.
   */
  private async logRenewal(
    group: HostGroup,
    reason: RenewalReason,
    discoveryMs: number,
    discoveredAt: number,
    fetches: Promise<UsageReportEntry>[],
    slowCalls: UsageSourceCall[],
  ): Promise<void> {
    if (!this.logger.info && !this.logger.debug) return;
    await Promise.allSettled(fetches);
    const line = {
      group: groupName(group),
      reason,
      discoveryMs,
      fetchMs: this.now() - discoveredAt,
      reports: fetches.length,
      ...(slowCalls.length > 0 ? { slowCalls } : {}),
    };
    if (fetches.length === 0 && slowCalls.length === 0)
      this.logger.debug?.(line, "Usage source group renewed");
    else this.logger.info?.(line, "Usage source group renewed");
  }

  /** Reports a source call longer than SLOW_USAGE_CALL_MS; see UsageSourceCall. */
  private noteSourceCall(call: UsageSourceCall, report?: SlowCallReport): void {
    if (call.durationMs <= SLOW_USAGE_CALL_MS) return;
    if (report) report(call);
    else this.logger.info?.(call, "Usage source call slow");
  }

  /** Collects a slow call nobody waited for; see BACKGROUND_SLOW_CALL_WINDOW_MS. */
  private readonly noteBackgroundSlowCall: SlowCallReport = (call) => {
    this.backgroundSlowCallsFrom ??= this.now();
    const kind: BackgroundSlowCall = { sourceId: call.sourceId, phase: call.phase, ok: call.ok };
    const key = JSON.stringify([kind.sourceId, kind.phase, kind.ok]);
    if (this.backgroundSlowCalls.record(key, kind, call.durationMs))
      this.logger.info?.({ ...call, background: true }, "Usage source call slow");
  };

  /** Sums up the slow background calls of a window that has ended, on the query after it. */
  private flushBackgroundSlowCalls(): void {
    const from = this.backgroundSlowCallsFrom;
    const now = this.now();
    if (from === undefined || now - from < BACKGROUND_SLOW_CALL_WINDOW_MS) return;
    this.backgroundSlowCallsFrom = now;
    for (const { fields, count, p50Ms, maxMs } of this.backgroundSlowCalls.flush()) {
      this.logger.info?.(
        { ...fields, background: true, count, p50Ms, maxMs, windowMs: now - from },
        "Usage source call slow summary",
      );
    }
  }

  /**
   * Whether a host group renewal will fetch this cache entry before it ends. An agent running under
   * a login the host also lists shares the host's entry, and renewing it apart from its group would
   * fetch it twice in each cache window. A host asked at least once a minute renews its groups
   * before their windows end; once its queries stop, the agent renews the entry itself.
   */
  private renewedByHostGroup(cacheKey: string): boolean {
    const lastHostQuery = this.hostQueries[this.hostQueries.length - 1];
    if (lastHostQuery === undefined || this.now() - lastHostQuery > this.renewAheadMs) return false;
    return this.hostReports().some((reports) =>
      [...reports.keys()].some((id) => {
        const known = this.known.get(id);
        return known !== undefined && cacheIdentity(id, known) === cacheKey;
      }),
    );
  }

  /** Each registered source's host accounts, in registration order. */
  private hostReports(): Map<string, KnownReport>[] {
    return [...this.sources.values()].flatMap((source) => {
      const found = this.defaults.get(source);
      return found ? [found.reports] : [];
    });
  }

  private mergeKnown(): void {
    this.known.clear();
    for (const reports of [
      ...this.hostReports(),
      ...[...this.byAgent.values()].map((agent) => agent.reports),
    ]) {
      for (const [id, report] of reports) {
        if (this.sources.get(report.source.id) !== report.source) continue;
        const known = this.known.get(id);
        if (!known) {
          this.known.set(id, { ...report, logins: [...report.logins] });
          continue;
        }
        for (const login of report.logins) {
          if (!known.logins.some((existing) => loginKey(existing) === loginKey(login)))
            known.logins.push(login);
        }
      }
    }
    // Fetch freshness expires independently of successful snapshots. Retain only live identities.
    const active = this.activeCacheKeys();
    for (const key of this.successful.keys()) if (!active.has(key)) this.successful.delete(key);
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
  }

  private activeCacheKeys(): Set<string> {
    return new Set(
      [
        this.known,
        ...this.hostReports(),
        ...[...this.byAgent.values()].map((agent) => agent.reports),
      ].flatMap((reports) => [...reports].map(([id, report]) => cacheIdentity(id, report))),
    );
  }

  private async discover(scope: UsageScope): Promise<Map<string, KnownReport>> {
    const discovered = await Promise.all(
      [...this.sources.values()].map((source) => this.discoverSource(source, scope)),
    );
    const merged = new Map<string, KnownReport>();
    // Session discovery keeps nothing from a failed source because a resumed agent may use a
    // different launch environment.
    for (const reports of discovered) {
      for (const [id, report] of reports ?? []) merged.set(id, report);
    }
    return merged;
  }

  /**
   * The accounts a source reports for a scope, or null when it could not be asked. A slow call
   * goes to `report`, or to a line of its own when no renewal collects it.
   */
  private async discoverSource(
    source: UsageSource,
    scope: UsageScope,
    report?: SlowCallReport,
  ): Promise<Map<string, KnownReport> | null> {
    const startedAt = this.now();
    const reports = await this.readSourceAccounts(source, scope);
    this.noteSourceCall(
      {
        sourceId: source.id,
        phase: "discover",
        scope: scope.kind,
        durationMs: this.now() - startedAt,
        ok: reports !== null,
      },
      report,
    );
    return reports;
  }

  private async readSourceAccounts(
    source: UsageSource,
    scope: UsageScope,
  ): Promise<Map<string, KnownReport> | null> {
    const reports = new Map<string, KnownReport>();
    try {
      const accounts = z
        .array(
          z.object({
            key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
            label: z.string().optional(),
            harness: z.string().min(1).optional(),
            input: z.json(),
          }),
        )
        .parse(await source.discover(scope));
      for (const account of accounts) {
        const id = `${source.id}:${account.key}`;
        const known = reports.get(id);
        // COMPAT(usageLoginHarness): added in v0.11.0, remove after 2027-04-05 once plugin floor >= v0.11.0.
        const login = { input: account.input, harness: account.harness ?? source.label };
        if (known) {
          if (!known.logins.some((existing) => loginKey(existing) === loginKey(login)))
            known.logins.push(login);
        } else reports.set(id, { source, logins: [login], label: account.label });
      }
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage source discovery failed");
      return null;
    }
    return reports;
  }

  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
  async listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
    const reports = await this.listReports();
    return {
      fetchedAt: reports.length
        ? reports.reduce(
            (oldest, entry) => (entry.fetchedAt < oldest ? entry.fetchedAt : oldest),
            reports[0]!.fetchedAt,
          )
        : new Date(this.now()).toISOString(),
      providers: reports.map((entry) => ({
        providerId: entry.sourceId,
        displayName: entry.account.label
          ? `${entry.sourceLabel} (${entry.account.label})`
          : entry.sourceLabel,
        status: entry.report.status,
        planLabel: entry.report.status === "available" ? (entry.report.planLabel ?? null) : null,
        windows: entry.report.status === "available" ? entry.report.windows : [],
        balances: entry.report.status === "available" ? (entry.report.balances ?? []) : [],
        details: entry.report.status === "available" ? (entry.report.details ?? []) : [],
        error: legacyError(entry.report, this.now()),
      })),
    };
  }

  /**
   * A forced or renewed query shares a running fetch only if it started after `startedAfter`, a
   * `fetchSeq` the caller read before the logins it trusts were read. A cached query shares any.
   */
  private fetchId(
    id: string,
    known: KnownReport,
    mode: FetchMode = "cached",
    renewAhead = false,
    startedAfter = -1,
    report?: SlowCallReport,
  ): Promise<UsageReportEntry> {
    // Account identity groups cards; the ordered login set identifies a fetch result.
    const cacheKey = cacheIdentity(id, known);
    const present = (entry: UsageReportEntry): UsageReportEntry =>
      entry.id === id &&
      entry.sourceLabel === known.source.label &&
      entry.icon === known.source.icon &&
      entry.account.label === known.label
        ? entry
        : {
            ...entry,
            id,
            sourceId: known.source.id,
            sourceLabel: known.source.label,
            icon: known.source.icon,
            account: { label: known.label },
          };
    const cached = this.cache.get(cacheKey);
    const running = this.pending.get(cacheKey);
    const shared =
      running && (mode === "cached" || running.seq > startedAfter) ? running : undefined;
    if (mode === "renewed" && shared) return shared.request.then(present);
    if (mode !== "forced" && cached && this.now() - cached.at < this.ttlMs) {
      if (
        renewAhead &&
        !running &&
        this.now() - cached.at >= this.ttlMs - this.renewAheadMs &&
        !this.renewedByHostGroup(cacheKey)
      )
        void this.fetchId(id, known, "forced", false, -1, this.noteBackgroundSlowCall);
      return Promise.resolve(present(cached.entry));
    }
    if (shared) return shared.request.then(present);
    // The fetch it replaces may answer from the replaced token, and answering last it would
    // stand in the cache for the whole window.
    running?.supersede();
    const seq = ++this.fetchSeq;
    let superseded = false;
    const request = (async () => {
      const startedAt = this.now();
      const fetchedAt = new Date(startedAt).toISOString();
      const outcome = await this.fetchWithFallback(known);
      // Timed where the fetch starts, so a query that joins it does not report it again.
      this.noteSourceCall(
        {
          sourceId: known.source.id,
          phase: "fetch",
          durationMs: this.now() - startedAt,
          ok: outcome.report.status !== "error",
        },
        report,
      );
      const completedAt = new Date(this.now()).toISOString();
      const entry: UsageReportEntry = {
        id,
        sourceId: known.source.id,
        sourceLabel: known.source.label,
        icon: known.source.icon,
        account: { label: known.label },
        fetchedAt,
        ...outcome,
      };
      if (entry.report.status === "available") {
        entry.successfulAt = completedAt;
      } else {
        entry.lastSuccessful = this.successful.get(cacheKey);
      }
      if (
        !superseded &&
        this.sources.get(known.source.id) === known.source &&
        this.activeCacheKeys().has(cacheKey)
      ) {
        if (entry.report.status === "available") {
          this.successful.set(cacheKey, {
            fetchedAt: completedAt,
            report: entry.report,
          });
        }
        this.writeCache(cacheKey, entry);
      }
      return entry;
    })();
    const started: RunningFetch = {
      request,
      seq,
      supersede: () => {
        superseded = true;
      },
    };
    this.pending.set(cacheKey, started);
    void started.request.finally(() => {
      if (this.pending.get(cacheKey) === started) this.pending.delete(cacheKey);
    });
    return started.request;
  }

  private writeCache(id: string, entry: UsageReportEntry): void {
    const at = this.now();
    for (const [cachedId, cached] of this.cache) {
      if (at - cached.at >= this.ttlMs) this.cache.delete(cachedId);
    }
    this.cache.set(id, { at, entry });
  }

  private async fetchBeforeDeadline(source: UsageSource, input: unknown): Promise<UsageReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UsageReport>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "error", error: "Usage fetch timed out" }),
        this.deadlineMs,
      );
    });
    try {
      return await Promise.race([this.fetchLogin(source, input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithFallback(
    known: KnownReport,
  ): Promise<Pick<UsageReportEntry, "report" | "loginErrors">> {
    // Start each login within the same deadline window, then prefer discovery order.
    // Sequential deadlines can exceed the client's RPC timeout before all errors arrive.
    const attempts = known.logins.map((login) =>
      this.fetchBeforeDeadline(known.source, login.input),
    );
    const loginErrors: NonNullable<UsageReportEntry["loginErrors"]> = [];
    for (const [index, login] of known.logins.entries()) {
      const report = await attempts[index]!;
      if (report.status === "available") return { report };
      loginErrors.push({ harness: login.harness, report });
    }
    // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once app floor >= v0.11.0.
    // Keep the final single report so older apps still parse and display failed accounts.
    return { report: loginErrors[loginErrors.length - 1]!.report, loginErrors };
  }

  private async fetchLogin(source: UsageSource, input: unknown): Promise<UsageReport> {
    try {
      return UsageReportSchema.parse(await source.fetch(input));
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage fetch failed");
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// The legacy RPC has only an error string; the current app owns its own presentation.
// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyProblem(problem: UsageProblem, now: number): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh it.`
    : "Sign in again.";
  if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
  const elapsed = Math.max(0, now - Date.parse(problem.expiresAt));
  let ago = "just now";
  if (elapsed >= 86_400_000) ago = `${Math.floor(elapsed / 86_400_000)}d ago`;
  else if (elapsed >= 3_600_000) ago = `${Math.floor(elapsed / 3_600_000)}h ago`;
  else if (elapsed >= 60_000) ago = `${Math.floor(elapsed / 60_000)}m ago`;
  return `Login expired ${ago}. ${remedy}`;
}

// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyError(report: UsageReport, now: number): string | null {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return legacyProblem(report.problem, now);
  return null;
}

// Inputs are opaque JSON locators. Canonical equality deduplicates discovery across scopes.
function loginKey(login: Login): string {
  return JSON.stringify(login, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

function hostGroup(source: UsageSource): HostGroup {
  return source.cacheGroup || source;
}

function groupName(group: HostGroup): string {
  return typeof group === "string" ? group : group.id;
}

function cacheIdentity(id: string, known: KnownReport): string {
  const identity = known.source.cacheGroup
    ? `${known.source.cacheGroup}:${id.slice(known.source.id.length + 1)}`
    : id;
  return `${identity}:${createHash("sha256")
    .update(JSON.stringify([known.label, known.logins.map(loginKey)]))
    .digest("hex")}`;
}
