import type { BenchmarkReturn } from "../domain/types";
import { logDebug, logInfo, logWarn } from "./logger";

const LOG_SCOPE = "benchmarkApi";
export const BENCHMARK_CANDIDATES = [
  { code: "000001", name: "上证指数", secid: "1.000001" },
  { code: "000300", name: "沪深300", secid: "1.000300" },
  { code: "000905", name: "中证500", secid: "1.000905" },
  { code: "399006", name: "创业板指", secid: "0.399006" },
  { code: "HSI", name: "恒生指数", secid: "100.HSI" },
  { code: "HSTECH", name: "恒生科技", secid: "124.HSTECH" },
  { code: "NDX100", name: "纳斯达克100", secid: "100.NDX100" },
  { code: "SPX", name: "标普500", secid: "100.SPX" }
];

export const DEFAULT_BENCHMARK_CODES = ["000300", "000905", "399006"];
export const MAX_BENCHMARK_SELECTION = 4;

export const normalizeBenchmarkCodes = (codes?: string[]) => {
  const availableCodes = new Set(BENCHMARK_CANDIDATES.map((item) => item.code));
  const nextCodes = (codes ?? DEFAULT_BENCHMARK_CODES).filter((code) => availableCodes.has(code));
  return Array.from(new Set(nextCodes)).slice(0, MAX_BENCHMARK_SELECTION);
};

export const fetchBenchmarkReturns = async (
  startDate: string,
  benchmarkCodes = DEFAULT_BENCHMARK_CODES
): Promise<BenchmarkReturn[]> => {
  const enabledBenchmarks = normalizeBenchmarkCodes(benchmarkCodes)
    .map((code) => BENCHMARK_CANDIDATES.find((item) => item.code === code))
    .filter((item): item is BenchmarkCandidate => Boolean(item));

  const results = await Promise.all(
    enabledBenchmarks.map(async (benchmark) => {
      try {
        return await fetchBenchmarkReturn(benchmark, startDate);
      } catch (error) {
        logWarn(LOG_SCOPE, "benchmark fetch:failed", {
          code: benchmark.code,
          error: error instanceof Error ? error.message : "指数数据获取失败"
        });
        return null;
      }
    })
  );

  return results.filter((item): item is BenchmarkReturn => item !== null);
};

const fetchBenchmarkReturn = async (
  benchmark: BenchmarkCandidate,
  startDate: string
): Promise<BenchmarkReturn> => {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.searchParams.set("secid", benchmark.secid);
  url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6");
  url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61");
  url.searchParams.set("klt", "101");
  url.searchParams.set("fqt", "1");
  url.searchParams.set("beg", compactDate(addDays(startDate, -21)));
  url.searchParams.set("end", compactDate(new Date().toISOString().slice(0, 10)));

  logInfo(LOG_SCOPE, "benchmark request:start", { code: benchmark.code, startDate });
  const response = await fetchWithTimeout(url.toString());
  logDebug(LOG_SCOPE, "benchmark response:status", {
    code: benchmark.code,
    status: response.status,
    contentType: response.headers.get("content-type")
  });
  if (!response.ok) {
    throw new Error(`指数行情请求失败：${response.status}`);
  }

  const payload = await response.json() as BenchmarkKlineResponse;
  const klines = payload.data?.klines?.map(parseKline).filter((item): item is KlinePoint => item !== null) ?? [];
  if (!payload.data || klines.length === 0) {
    throw new Error("指数行情返回为空");
  }

  const targetTime = new Date(`${startDate}T23:59:59`).getTime();
  const initial = [...klines].reverse().find((item) => new Date(`${item.date}T00:00:00`).getTime() <= targetTime);
  const current = klines.at(-1);
  if (!initial || !current || !Number.isFinite(initial.close) || !Number.isFinite(current.close)) {
    throw new Error("指数行情缺少有效收盘价");
  }

  const returnRate = (current.close - initial.close) / initial.close;
  logInfo(LOG_SCOPE, "benchmark parse:ok", {
    code: benchmark.code,
    startDate: initial.date,
    endDate: current.date,
    returnRate
  });

  return {
    code: benchmark.code,
    name: payload.data.name || benchmark.name,
    startDate: initial.date,
    endDate: current.date,
    startClose: initial.close,
    endClose: current.close,
    returnRate
  };
};

const fetchWithTimeout = async (url: string) => {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("指数行情请求超时");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
};

const parseKline = (line: string) => {
  const [date, , closeText] = line.split(",");
  const close = Number(closeText);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) {
    return null;
  }
  return { date, close };
};

interface KlinePoint {
  date: string;
  close: number;
}

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
};

const compactDate = (date: string) => date.replaceAll("-", "");

interface BenchmarkKlineResponse {
  data?: {
    name?: string;
    klines?: string[];
  };
}

type BenchmarkCandidate = (typeof BENCHMARK_CANDIDATES)[number];
