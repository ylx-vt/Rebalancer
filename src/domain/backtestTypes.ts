export type BacktestRuleType =
  | "buy-and-hold"
  | "fixed-frequency"
  | "threshold"
  | "frequency-threshold";

export type BacktestFrequency = "monthly" | "quarterly" | "semiannual" | "annual";

export type BacktestThresholdMode = "absolute-pp" | "relative-percent";

export interface BacktestRule {
  id: string;
  name: string;
  type: BacktestRuleType;
  frequency?: BacktestFrequency;
  thresholdMode?: BacktestThresholdMode;
  thresholdValue?: number;
}

export interface BacktestInput {
  configId: string;
  startDate: string;
  endDate: string;
  initialAmount: number;
  riskFreeRatePercent: number;
  rules: BacktestRule[];
}

export interface NavPoint {
  date: string;
  nav: number;
}

export interface HoldingNavSeries {
  holdingId: string;
  kind: "fund" | "cash";
  code?: string;
  name: string;
  targetPercent: number;
  points: NavPoint[];
}

export interface BacktestTimelinePoint {
  date: string;
  totalValue: number;
  normalizedValue: number;
  dailyReturn: number;
  drawdown: number;
  holdings: BacktestHoldingState[];
}

export interface BacktestHoldingState {
  holdingId: string;
  value: number;
  shares: number;
  nav: number;
  targetPercent: number;
  currentPercent: number;
  driftPercentPoints: number;
  relativeDriftPercent: number;
}

export interface BacktestRebalanceRecord {
  id: string;
  date: string;
  ruleId: string;
  ruleName: string;
  triggerReason: string;
  beforeTotalValue: number;
  turnoverAmount: number;
  items: BacktestRebalanceItem[];
}

export interface BacktestRebalanceItem {
  holdingId: string;
  name: string;
  amount: number;
  beforeValue: number;
  afterValue: number;
}

export interface BacktestRuleResult {
  rule: BacktestRule;
  finalAmount: number;
  cumulativeReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  annualizedVolatility: number;
  sharpeRatio: number | null;
  calmarRatio: number | null;
  returnDrawdownRatio: number | null;
  dailyWinRate: number;
  bestDailyReturn: number;
  worstDailyReturn: number;
  maxDrawdownDays: number;
  rebalanceCount: number;
  totalTurnoverAmount: number;
  annualizedTurnoverRate: number;
  averageRebalanceAmount: number;
  timeline: BacktestTimelinePoint[];
  rebalanceRecords: BacktestRebalanceRecord[];
}

export interface BacktestResult {
  input: BacktestInput;
  requestedStartDate: string;
  requestedEndDate: string;
  actualStartDate: string;
  actualEndDate: string;
  rangeAdjustment: BacktestRangeAdjustment;
  results: BacktestRuleResult[];
}

export interface BacktestRangeAdjustment {
  startLimitedBy: BacktestRangeLimitItem[];
  endLimitedBy: BacktestRangeLimitItem[];
}

export interface BacktestRangeLimitItem {
  holdingId: string;
  code?: string;
  name: string;
  availableStartDate: string;
  availableEndDate: string;
}

export interface HistoricalSeriesCacheItem {
  code: string;
  startDate: string;
  endDate: string;
  points: NavPoint[];
  fetchedAt: number;
}
