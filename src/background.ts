import { fetchFundSnapshot, fetchHistoricalNavBeforeOrOn, fetchHistoricalNavSeries } from "./services/fundApi";
import { fetchBenchmarkReturns } from "./services/benchmarkApi";

type RuntimeRequest =
  | { type: "fund:snapshot"; code: string }
  | { type: "fund:historical"; code: string; date: string }
  | { type: "fund:historical-series"; code: string; startDate: string; endDate: string }
  | { type: "benchmark:returns"; startDate: string; benchmarkCodes: string[] };

chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  const run = async () => {
    if (request.type === "fund:snapshot") {
      return fetchFundSnapshot(request.code);
    }
    if (request.type === "fund:historical") {
      return fetchHistoricalNavBeforeOrOn(request.code, request.date);
    }
    if (request.type === "fund:historical-series") {
      return fetchHistoricalNavSeries(request.code, request.startDate, request.endDate);
    }
    if (request.type === "benchmark:returns") {
      return fetchBenchmarkReturns(request.startDate, request.benchmarkCodes);
    }
    throw new Error("未知请求");
  };

  run()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "请求失败"
      })
    );

  return true;
});
