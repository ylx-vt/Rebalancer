import type { AppState, FundSnapshot, HistoricalNav, PortfolioConfig } from "../domain/types";
import type { HoldingQuote } from "../domain/calculation";
import { fetchFundSnapshot, fetchHistoricalNavBeforeOrOn } from "./fundApi";
import { logDebug, logInfo, logWarn } from "./logger";

const CACHE_TTL_MS = 60_000;
const LOG_SCOPE = "fundClient";

type RuntimeResponse<T> = { ok: true; data: T } | { ok: false; error: string };

const hasRuntimeMessaging = () =>
  typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);

const sendRuntimeMessage = async <T>(message: unknown): Promise<T> => {
  const response = (await chrome.runtime.sendMessage(message)) as RuntimeResponse<T> | undefined;
  if (!response) {
    throw new Error("后台请求无响应");
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.data;
};

export const getCachedSnapshot = async (
  code: string,
  state: AppState,
  forceRefresh: boolean
): Promise<FundSnapshot> => {
  const cached = state.fundCache[code];
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    logDebug(LOG_SCOPE, "snapshot cache:hit", { code, navDate: cached.navDate });
    return cached;
  }

  logDebug(LOG_SCOPE, "snapshot cache:miss", { code, forceRefresh });
  if (hasRuntimeMessaging()) {
    return sendRuntimeMessage<FundSnapshot>({ type: "fund:snapshot", code });
  }

  return fetchFundSnapshot(code);
};

export const getCachedHistoricalNav = async (
  code: string,
  date: string,
  state: AppState,
  forceRefresh: boolean
): Promise<HistoricalNav> => {
  const key = historicalCacheKey(code, date);
  const cached = state.historicalCache[key];
  if (!forceRefresh && cached) {
    logDebug(LOG_SCOPE, "historical cache:hit", { code, date, navDate: cached.navDate });
    return cached;
  }

  logDebug(LOG_SCOPE, "historical cache:miss", { code, date, forceRefresh });
  if (hasRuntimeMessaging()) {
    return sendRuntimeMessage<HistoricalNav>({ type: "fund:historical", code, date });
  }

  return fetchHistoricalNavBeforeOrOn(code, date);
};

export const loadQuotesForConfig = async (
  config: PortfolioConfig,
  state: AppState,
  forceRefresh: boolean
): Promise<{
  quotes: Record<string, HoldingQuote>;
  fundCachePatch: AppState["fundCache"];
  historicalCachePatch: AppState["historicalCache"];
}> => {
  const fundCodes = Array.from(
    new Set(
      config.holdings
        .filter((holding) => holding.kind === "fund" && holding.code)
        .map((holding) => holding.code!)
    )
  );

  logInfo(LOG_SCOPE, "quotes load:start", {
    configId: config.id,
    startDate: config.startDate,
    fundCount: fundCodes.length,
    forceRefresh
  });

  const entries = await Promise.all(
    fundCodes.map(async (code) => {
      try {
        const [current, initial] = await Promise.all([
          getCachedSnapshot(code, state, forceRefresh),
          getCachedHistoricalNav(code, config.startDate, state, forceRefresh)
        ]);
        logInfo(LOG_SCOPE, "quotes load:item-ok", {
          code,
          currentNavDate: current.navDate,
          initialNavDate: initial.navDate
        });
        return [code, { status: "ready", current, initial } satisfies HoldingQuote] as const;
      } catch (error) {
        logWarn(LOG_SCOPE, "quotes load:item-failed", {
          code,
          error: error instanceof Error ? error.message : "基金数据获取失败"
        });
        return [
          code,
          {
            status: "failed",
            error: error instanceof Error ? error.message : "基金数据获取失败"
          } satisfies HoldingQuote
        ] as const;
      }
    })
  );

  const quotes = Object.fromEntries(entries);
  const readyQuotes = entries.filter((entry) => entry[1].status === "ready");
  logInfo(LOG_SCOPE, "quotes load:done", {
    total: entries.length,
    ready: readyQuotes.length,
    failed: entries.length - readyQuotes.length
  });

  return {
    quotes,
    fundCachePatch: Object.fromEntries(
      readyQuotes.map(([code, quote]) => [code, quote.status === "ready" ? quote.current : undefined])
    ) as AppState["fundCache"],
    historicalCachePatch: Object.fromEntries(
      readyQuotes.map(([code, quote]) => [
        historicalCacheKey(code, config.startDate),
        quote.status === "ready" ? quote.initial : undefined
      ])
    ) as AppState["historicalCache"]
  };
};

export const historicalCacheKey = (code: string, date: string) => `${code}:${date}`;
