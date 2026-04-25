import type { BenchmarkReturn } from "../domain/types";
import { fetchBenchmarkReturns } from "./benchmarkApi";

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

export const loadBenchmarkReturns = async (
  startDate: string,
  benchmarkCodes: string[]
): Promise<BenchmarkReturn[]> => {
  if (hasRuntimeMessaging()) {
    return sendRuntimeMessage<BenchmarkReturn[]>({ type: "benchmark:returns", startDate, benchmarkCodes });
  }

  return fetchBenchmarkReturns(startDate, benchmarkCodes);
};
