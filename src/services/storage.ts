import type { AppState } from "../domain/types";
import { DEFAULT_THRESHOLDS } from "../domain/calculation";
import { normalizeBenchmarkCodes } from "./benchmarkApi";

const STORAGE_KEY = "rebalancer:v1";

export const createInitialState = (): AppState => ({
  schemaVersion: 1,
  configs: [],
  fundCache: {},
  historicalCache: {}
});

const isChromeStorageAvailable = () =>
  typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

export const loadState = async (): Promise<AppState> => {
  if (isChromeStorageAvailable()) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeState(result[STORAGE_KEY]);
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  return normalizeState(raw ? JSON.parse(raw) : undefined);
};

export const saveState = async (state: AppState): Promise<void> => {
  if (isChromeStorageAvailable()) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

const normalizeState = (value: unknown): AppState => {
  if (!value || typeof value !== "object") {
    return createInitialState();
  }

  const state = value as Partial<AppState>;
  return {
    schemaVersion: 1,
    configs: Array.isArray(state.configs)
      ? state.configs.map((config) => ({
          ...config,
          benchmarkCodes: normalizeBenchmarkCodes(config.benchmarkCodes),
          thresholds: {
            absolutePercentPoints:
              config.thresholds?.absolutePercentPoints ?? DEFAULT_THRESHOLDS.absolutePercentPoints,
            relativePercent: config.thresholds?.relativePercent ?? DEFAULT_THRESHOLDS.relativePercent
          }
        }))
      : [],
    primaryConfigId: state.primaryConfigId,
    selectedConfigId: state.selectedConfigId,
    fundCache: state.fundCache ?? {},
    historicalCache: state.historicalCache ?? {}
  };
};
