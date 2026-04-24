import { fetchFundSnapshot, fetchHistoricalNavBeforeOrOn } from "./services/fundApi";

type RuntimeRequest =
  | { type: "fund:snapshot"; code: string }
  | { type: "fund:historical"; code: string; date: string };

chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  const run = async () => {
    if (request.type === "fund:snapshot") {
      return fetchFundSnapshot(request.code);
    }
    if (request.type === "fund:historical") {
      return fetchHistoricalNavBeforeOrOn(request.code, request.date);
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
