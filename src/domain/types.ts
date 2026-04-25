export type HoldingKind = "fund" | "cash";

export interface HoldingConfig {
  id: string;
  kind: HoldingKind;
  code?: string;
  name: string;
  targetPercent: number;
}

export interface RebalanceThresholds {
  absolutePercentPoints: number;
  relativePercent: number;
}

export interface PortfolioConfig {
  id: string;
  name: string;
  totalAmount: number;
  startDate: string;
  benchmarkCodes: string[];
  thresholds: RebalanceThresholds;
  holdings: HoldingConfig[];
  createdAt: number;
  updatedAt: number;
}

export interface FundSnapshot {
  code: string;
  name: string;
  nav: number;
  navDate: string;
  fetchedAt: number;
}

export interface HistoricalNav {
  code: string;
  nav: number;
  navDate: string;
  fetchedAt: number;
}

export interface HoldingObservation {
  holding: HoldingConfig;
  targetValue: number;
  startNav: number;
  currentNav: number;
  shares: number;
  marketValue: number;
  targetPercent: number;
  currentPercent: number;
  driftPercentPoints: number;
  relativeDriftPercent: number;
  rebalanceAmount: number;
  rebalanceStatus: RebalanceStatus;
  navDate?: string;
  error?: string;
}

export type RebalanceStatus = "ok" | "watch" | "rebalance" | "error";

export interface PortfolioObservation {
  totalMarketValue: number;
  profitAmount: number;
  profitRate: number;
  portfolioDriftPercent: number;
  rebalanceStatus: RebalanceStatus;
  holdings: HoldingObservation[];
}

export interface BenchmarkReturn {
  code: string;
  name: string;
  startDate: string;
  endDate: string;
  startClose: number;
  endClose: number;
  returnRate: number;
}

export interface AppState {
  schemaVersion: 1;
  configs: PortfolioConfig[];
  primaryConfigId?: string;
  selectedConfigId?: string;
  fundCache: Record<string, FundSnapshot>;
  historicalCache: Record<string, HistoricalNav>;
}

export interface ImportParser {
  formatName: string;
  canParse(raw: unknown): boolean;
  extractCodes(raw: unknown): string[];
}

export interface ImportResult {
  codes: string[];
  parserName: string;
  skippedCount: number;
}
