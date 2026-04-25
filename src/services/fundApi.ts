import type { FundSnapshot, HistoricalNav } from "../domain/types";
import type { NavPoint } from "../domain/backtestTypes";
import { logDebug, logError, logInfo, logWarn } from "./logger";

const REQUEST_TIMEOUT_MS = 10_000;
const LOG_SCOPE = "fundApi";
const MAX_HISTORY_PAGES = 30;

const withTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("请求超时");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

export const fetchFundSnapshot = async (code: string): Promise<FundSnapshot> => {
  const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
  logInfo(LOG_SCOPE, "snapshot request:start", { code });
  const response = await withTimeout(url);
  logDebug(LOG_SCOPE, "snapshot response:status", {
    code,
    status: response.status,
    contentType: response.headers.get("content-type")
  });
  if (!response.ok) {
    throw new Error(`实时净值请求失败：${response.status}`);
  }

  const text = await response.text();
  logDebug(LOG_SCOPE, "snapshot response:preview", { code, preview: text.slice(0, 160) });
  const match = text.match(/^jsonpgz\((.*)\);?$/);
  if (!match) {
    logWarn(LOG_SCOPE, "snapshot parse:invalid-jsonp", { code, preview: text.slice(0, 240) });
    throw new Error("实时净值返回格式异常");
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    throw new Error("实时净值解析失败");
  }

  const name = readString(raw.name);
  const nav = readNumber(raw.dwjz);
  const navDate = readString(raw.jzrq);
  const fundCode = readString(raw.fundcode) || code;

  if (!name || !Number.isFinite(nav)) {
    logWarn(LOG_SCOPE, "snapshot parse:missing-fields", { code, raw });
    throw new Error("实时净值缺少名称或单位净值");
  }

  logInfo(LOG_SCOPE, "snapshot parse:ok", { code: fundCode, name, nav, navDate });
  return {
    code: fundCode,
    name,
    nav,
    navDate,
    fetchedAt: Date.now()
  };
};

export const fetchHistoricalNavBeforeOrOn = async (
  code: string,
  date: string
): Promise<HistoricalNav> => {
  try {
    return await fetchHistoricalNavFromJsonApi(code, date);
  } catch (error) {
    logWarn(LOG_SCOPE, "historical primary:failed, fallback:start", {
      code,
      date,
      error: readError(error)
    });
    return fetchHistoricalNavFromHtmlApi(code, date);
  }
};

export const fetchHistoricalNavSeries = async (
  code: string,
  startDate: string,
  endDate: string
): Promise<NavPoint[]> => {
  try {
    return await fetchHistoricalNavSeriesFromJsonApi(code, startDate, endDate);
  } catch (error) {
    logWarn(LOG_SCOPE, "historical series primary:failed, fallback:start", {
      code,
      startDate,
      endDate,
      error: readError(error)
    });
    return fetchHistoricalNavSeriesFromHtmlApi(code, startDate, endDate);
  }
};

const fetchHistoricalNavFromJsonApi = async (code: string, date: string): Promise<HistoricalNav> => {
  const targetTime = new Date(`${date}T23:59:59`).getTime();
  let lastSeenDate = "";

  for (let pageIndex = 1; pageIndex <= MAX_HISTORY_PAGES; pageIndex += 1) {
    const url = new URL("https://api.fund.eastmoney.com/f10/lsjz");
    url.searchParams.set("fundCode", code);
    url.searchParams.set("pageIndex", String(pageIndex));
    url.searchParams.set("pageSize", "120");

    logInfo(LOG_SCOPE, "historical primary request:start", { code, date, pageIndex });
    const response = await withTimeout(url.toString(), {
      referrer: "https://fund.eastmoney.com/",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    logDebug(LOG_SCOPE, "historical primary response:status", {
      code,
      pageIndex,
      status: response.status,
      contentType: response.headers.get("content-type")
    });
    if (!response.ok) {
      throw new Error(`历史净值请求失败：${response.status}`);
    }

    const text = await response.text();
    logDebug(LOG_SCOPE, "historical primary response:preview", {
      code,
      pageIndex,
      preview: text.slice(0, 240)
    });

    let raw: {
      ErrCode?: number;
      Data?: { LSJZList?: Array<Record<string, unknown>> };
      ErrMsg?: string;
      PageSize?: number;
      TotalCount?: number;
    };
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch {
      logWarn(LOG_SCOPE, "historical primary parse:invalid-json", { code, preview: text.slice(0, 240) });
      throw new Error("历史净值 JSON 解析失败");
    }

    if (raw.ErrCode !== 0 || !Array.isArray(raw.Data?.LSJZList)) {
      logWarn(LOG_SCOPE, "historical primary parse:invalid-shape", {
        code,
        errCode: raw.ErrCode,
        errMsg: raw.ErrMsg,
        dataType: typeof raw.Data,
        keys: Object.keys(raw)
      });
      throw new Error(`历史净值返回格式异常（ErrCode: ${raw.ErrCode ?? "unknown"}）`);
    }

    const list = raw.Data.LSJZList;
    const row = list.find((item) => {
      const rowDate = readString(item.FSRQ);
      return rowDate ? new Date(`${rowDate}T00:00:00`).getTime() <= targetTime : false;
    });

    if (row) {
      const nav = readNumber(row.DWJZ);
      const navDate = readString(row.FSRQ);

      if (!Number.isFinite(nav) || !navDate) {
        logWarn(LOG_SCOPE, "historical primary parse:invalid-row", { code, row });
        throw new Error("历史净值字段异常");
      }

      logInfo(LOG_SCOPE, "historical primary parse:ok", { code, nav, navDate, pageIndex });
      return {
        code,
        nav,
        navDate,
        fetchedAt: Date.now()
      };
    }

    lastSeenDate = readString(list.at(-1)?.FSRQ) || lastSeenDate;
    const pageSize = raw.PageSize || 120;
    const totalPages = raw.TotalCount ? Math.ceil(raw.TotalCount / pageSize) : pageIndex;
    if (pageIndex >= totalPages || list.length === 0) {
      break;
    }
  }

  logWarn(LOG_SCOPE, "historical primary parse:no-row-before-date", { code, date, lastSeenDate });
  throw new Error("未找到起始日之前的历史净值");
};

const fetchHistoricalNavSeriesFromJsonApi = async (
  code: string,
  startDate: string,
  endDate: string
): Promise<NavPoint[]> => {
  const rows: NavPoint[] = [];

  for (let pageIndex = 1; pageIndex <= MAX_HISTORY_PAGES; pageIndex += 1) {
    const url = new URL("https://api.fund.eastmoney.com/f10/lsjz");
    url.searchParams.set("fundCode", code);
    url.searchParams.set("pageIndex", String(pageIndex));
    url.searchParams.set("pageSize", "120");

    logInfo(LOG_SCOPE, "historical series primary request:start", { code, startDate, endDate, pageIndex });
    const response = await withTimeout(url.toString(), {
      referrer: "https://fund.eastmoney.com/",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    if (!response.ok) {
      throw new Error(`历史净值序列请求失败：${response.status}`);
    }

    const text = await response.text();
    let raw: {
      ErrCode?: number;
      Data?: { LSJZList?: Array<Record<string, unknown>> };
      ErrMsg?: string;
      PageSize?: number;
      TotalCount?: number;
    };
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch {
      throw new Error("历史净值序列 JSON 解析失败");
    }

    if (raw.ErrCode !== 0 || !Array.isArray(raw.Data?.LSJZList)) {
      throw new Error(`历史净值序列返回格式异常（ErrCode: ${raw.ErrCode ?? "unknown"}）`);
    }

    raw.Data.LSJZList.forEach((item) => {
      const date = readString(item.FSRQ);
      const nav = readNumber(item.DWJZ);
      if (date >= startDate && date <= endDate && Number.isFinite(nav)) {
        rows.push({ date, nav });
      }
    });

    const oldestDate = readString(raw.Data.LSJZList.at(-1)?.FSRQ);
    const pageSize = raw.PageSize || 120;
    const totalPages = raw.TotalCount ? Math.ceil(raw.TotalCount / pageSize) : pageIndex;
    if (!oldestDate || oldestDate < startDate || pageIndex >= totalPages || raw.Data.LSJZList.length === 0) {
      break;
    }
  }

  return normalizeSeriesRows(code, startDate, endDate, rows);
};

const fetchHistoricalNavFromHtmlApi = async (code: string, date: string): Promise<HistoricalNav> => {
  const targetTime = new Date(`${date}T23:59:59`).getTime();
  let lastSeenDate = "";

  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const url = new URL("https://fundf10.eastmoney.com/F10DataApi.aspx");
    url.searchParams.set("type", "lsjz");
    url.searchParams.set("code", code);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per", "20");
    url.searchParams.set("sdate", "");
    url.searchParams.set("edate", "");
    url.searchParams.set("rt", String(Math.random()));

    logInfo(LOG_SCOPE, "historical fallback request:start", { code, date, page });
    const response = await withTimeout(url.toString());
    logDebug(LOG_SCOPE, "historical fallback response:status", {
      code,
      page,
      status: response.status,
      contentType: response.headers.get("content-type")
    });
    if (!response.ok) {
      throw new Error(`历史净值备用请求失败：${response.status}`);
    }

    const text = await response.text();
    logDebug(LOG_SCOPE, "historical fallback response:preview", {
      code,
      page,
      preview: text.slice(0, 240)
    });

    const rows = extractHistoricalRowsFromHtmlApi(text);
    const row = rows.find((item) => new Date(`${item.navDate}T00:00:00`).getTime() <= targetTime);

    if (row) {
      logInfo(LOG_SCOPE, "historical fallback parse:ok", { code, nav: row.nav, navDate: row.navDate, page });
      return {
        code,
        nav: row.nav,
        navDate: row.navDate,
        fetchedAt: Date.now()
      };
    }

    lastSeenDate = rows.at(-1)?.navDate || lastSeenDate;
    const totalPages = readHtmlApiPageCount(text);
    if (page >= totalPages || rows.length === 0) {
      break;
    }
  }

  logWarn(LOG_SCOPE, "historical fallback parse:no-row-before-date", { code, date, lastSeenDate });
  throw new Error("未找到起始日之前的历史净值");
};

const fetchHistoricalNavSeriesFromHtmlApi = async (
  code: string,
  startDate: string,
  endDate: string
): Promise<NavPoint[]> => {
  const rows: NavPoint[] = [];

  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const url = new URL("https://fundf10.eastmoney.com/F10DataApi.aspx");
    url.searchParams.set("type", "lsjz");
    url.searchParams.set("code", code);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per", "20");
    url.searchParams.set("sdate", "");
    url.searchParams.set("edate", "");
    url.searchParams.set("rt", String(Math.random()));

    logInfo(LOG_SCOPE, "historical series fallback request:start", { code, startDate, endDate, page });
    const response = await withTimeout(url.toString());
    if (!response.ok) {
      throw new Error(`历史净值序列备用请求失败：${response.status}`);
    }

    const text = await response.text();
    const pageRows = extractHistoricalRowsFromHtmlApi(text);
    pageRows.forEach((item) => {
      if (item.navDate >= startDate && item.navDate <= endDate) {
        rows.push({ date: item.navDate, nav: item.nav });
      }
    });

    const oldestDate = pageRows.at(-1)?.navDate;
    const totalPages = readHtmlApiPageCount(text);
    if (!oldestDate || oldestDate < startDate || page >= totalPages || pageRows.length === 0) {
      break;
    }
  }

  return normalizeSeriesRows(code, startDate, endDate, rows);
};

const normalizeSeriesRows = (code: string, startDate: string, endDate: string, rows: NavPoint[]) => {
  const uniqueRows = Array.from(new Map(rows.map((item) => [item.date, item])).values()).sort((left, right) =>
    left.date.localeCompare(right.date)
  );
  if (uniqueRows.length < 2) {
    throw new Error(`基金 ${code} 在 ${startDate} 至 ${endDate} 内历史净值不足 2 条`);
  }
  return uniqueRows;
};

const extractHistoricalRowsFromHtmlApi = (text: string): Array<{ navDate: string; nav: number }> => {
  const rows: Array<{ navDate: string; nav: number }> = [];
  const rowMatches = text.matchAll(/<tr>(.*?)<\/tr>/g);

  for (const rowMatch of rowMatches) {
    const cells = Array.from(rowMatch[1].matchAll(/<td(?:\s+[^>]*)?>(.*?)<\/td>/g)).map((cell) =>
      stripTags(cell[1]).trim()
    );
    const navDate = cells[0];
    const nav = readNumber(cells[1]);

    if (/^\d{4}-\d{2}-\d{2}$/.test(navDate) && Number.isFinite(nav)) {
      rows.push({ navDate, nav });
    }
  }

  if (rows.length === 0) {
    logError(LOG_SCOPE, "historical fallback parse:empty", { preview: text.slice(0, 240) });
    throw new Error("历史净值备用返回格式异常");
  }

  return rows;
};

const stripTags = (value: string) => value.replace(/<[^>]*>/g, "");

const readHtmlApiPageCount = (text: string) => {
  const match = text.match(/pages:(\d+)/);
  return match ? Number(match[1]) : 1;
};

const readError = (error: unknown) => (error instanceof Error ? error.message : "未知错误");

const readString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const readNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return Number.NaN;
};
