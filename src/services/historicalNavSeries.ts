import type { HoldingNavSeries, HistoricalSeriesCacheItem, NavPoint } from "../domain/backtestTypes";
import type { AppState, PortfolioConfig } from "../domain/types";
import { fetchHistoricalNavSeries } from "./fundApi";
import { logDebug, logInfo, logWarn } from "./logger";

const LOG_SCOPE = "historicalNavSeries";

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

export const historicalSeriesCacheKey = (code: string, startDate: string, endDate: string) =>
  `${code}:${startDate}:${endDate}`;

export const loadHistoricalNavSeriesForConfig = async (
  config: PortfolioConfig,
  state: AppState,
  startDate: string,
  endDate: string,
  forceRefresh: boolean
): Promise<{
  series: HoldingNavSeries[];
  cachePatch: Record<string, HistoricalSeriesCacheItem>;
}> => {
  const cache = state.historicalSeriesCache ?? {};
  const fundHoldings = config.holdings.filter((holding) => holding.kind === "fund" && holding.code?.trim());

  logInfo(LOG_SCOPE, "series load:start", {
    configId: config.id,
    startDate,
    endDate,
    fundCount: fundHoldings.length,
    forceRefresh
  });

  const entries = await Promise.all(
    config.holdings.map(async (holding) => {
      if (holding.kind === "cash") {
        return {
          series: {
            holdingId: holding.id,
            kind: "cash",
            name: holding.name,
            targetPercent: holding.targetPercent,
            points: [
              { date: startDate, nav: 1 },
              { date: endDate, nav: 1 }
            ]
          } satisfies HoldingNavSeries
        };
      }

      const code = holding.code?.trim();
      if (!code) {
        throw new Error(`持仓“${holding.name || "未命名"}”缺少基金代码`);
      }

      const cached = !forceRefresh ? findCoveringCache(code, startDate, endDate, cache) : undefined;
      if (cached) {
        logDebug(LOG_SCOPE, "series cache:hit", { code, startDate, endDate });
        return {
          series: {
            holdingId: holding.id,
            kind: "fund",
            code,
            name: holding.name,
            targetPercent: holding.targetPercent,
            points: cropPoints(cached.points, startDate, endDate)
          } satisfies HoldingNavSeries
        };
      }

      try {
        const points = await requestSeries(code, startDate, endDate);
        const key = historicalSeriesCacheKey(code, startDate, endDate);
        return {
          series: {
            holdingId: holding.id,
            kind: "fund",
            code,
            name: holding.name,
            targetPercent: holding.targetPercent,
            points
          } satisfies HoldingNavSeries,
          cacheItem: {
            code,
            startDate,
            endDate,
            points,
            fetchedAt: Date.now()
          } satisfies HistoricalSeriesCacheItem,
          key
        };
      } catch (error) {
        logWarn(LOG_SCOPE, "series load:item-failed", {
          code,
          error: error instanceof Error ? error.message : "历史净值序列获取失败"
        });
        throw new Error(`${code} 历史净值加载失败：${error instanceof Error ? error.message : "请求失败"}`);
      }
    })
  );

  return {
    series: entries.map((entry) => entry.series),
    cachePatch: Object.fromEntries(
      entries
        .filter((entry): entry is typeof entry & { key: string; cacheItem: HistoricalSeriesCacheItem } =>
          Boolean("key" in entry && entry.key && "cacheItem" in entry && entry.cacheItem)
        )
        .map((entry) => [entry.key, entry.cacheItem])
    )
  };
};

const requestSeries = async (code: string, startDate: string, endDate: string) => {
  if (hasRuntimeMessaging()) {
    return sendRuntimeMessage<NavPoint[]>({ type: "fund:historical-series", code, startDate, endDate });
  }
  return fetchHistoricalNavSeries(code, startDate, endDate);
};

const findCoveringCache = (
  code: string,
  startDate: string,
  endDate: string,
  cache: Record<string, HistoricalSeriesCacheItem>
) =>
  Object.values(cache).find(
    (item) => item.code === code && item.startDate <= startDate && item.endDate >= endDate && item.points.length > 0
  );

const cropPoints = (points: NavPoint[], startDate: string, endDate: string) =>
  points.filter((point) => point.date >= startDate && point.date <= endDate);
