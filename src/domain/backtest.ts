import { validatePortfolioConfig } from "./calculation";
import type {
  BacktestFrequency,
  BacktestHoldingState,
  BacktestInput,
  BacktestRebalanceRecord,
  BacktestResult,
  BacktestRule,
  BacktestRuleResult,
  BacktestTimelinePoint,
  HoldingNavSeries,
  NavPoint
} from "./backtestTypes";
import type { PortfolioConfig } from "./types";

type SharesState = Record<string, number>;
type NavLookup = Record<string, Map<string, number>>;

export const validateBacktestInput = (config: PortfolioConfig | undefined, input: BacktestInput): string[] => {
  const errors: string[] = [];

  if (!config) {
    return ["还没有可用于回测的配置"];
  }
  if (config.id !== input.configId) {
    errors.push("回测对象与当前配置不一致");
  }
  errors.push(...validatePortfolioConfig(config));
  config.holdings.forEach((holding) => {
    if (holding.kind === "fund" && !holding.code?.trim()) {
      errors.push(`持仓“${holding.name || "未命名"}”缺少基金代码`);
    }
  });
  if (!input.startDate || !input.endDate || input.startDate >= input.endDate) {
    errors.push("开始日期必须早于结束日期");
  }
  if (!(input.initialAmount > 0)) {
    errors.push("初始金额必须大于 0");
  }
  if (!Number.isFinite(input.riskFreeRatePercent)) {
    errors.push("无风险收益率必须是有效数字");
  }
  if (input.rules.length < 1) {
    errors.push("至少保留 1 条规则");
  }
  if (input.rules.length > 6) {
    errors.push("规则最多 6 条");
  }

  input.rules.forEach((rule) => {
    const name = rule.name.trim() || "未命名规则";
    if (!rule.name.trim()) {
      errors.push("规则名称不能为空");
    }
    if ((rule.type === "fixed-frequency" || rule.type === "frequency-threshold") && !rule.frequency) {
      errors.push(`规则“${name}”缺少检查频率`);
    }
    if (rule.type === "threshold" || rule.type === "frequency-threshold") {
      if (!rule.thresholdMode) {
        errors.push(`规则“${name}”缺少阈值模式`);
      }
      if (!(Number(rule.thresholdValue) > 0)) {
        errors.push(`规则“${name}”缺少大于 0 的阈值`);
      }
    }
  });

  return Array.from(new Set(errors));
};

export const runBacktest = (
  config: PortfolioConfig,
  input: BacktestInput,
  series: HoldingNavSeries[]
): BacktestResult => {
  const errors = validateBacktestInput(config, input);
  if (errors.length > 0) {
    throw new Error(errors[0]);
  }

  const normalizedSeries = normalizeSeries(config, series, input.startDate, input.endDate);
  const timelineDates = buildTimelineDates(normalizedSeries, input.startDate, input.endDate);
  if (timelineDates.length < 2) {
    throw new Error(`所选基金在 ${input.startDate} 至 ${input.endDate} 内没有共同可回测区间`);
  }

  const actualStartDate = timelineDates[0];
  const actualEndDate = timelineDates[timelineDates.length - 1];
  const navLookup = createNavLookup(normalizedSeries, timelineDates);
  const checkDates = createFrequencyCheckDateSet(timelineDates);
  const results = input.rules.map((rule) =>
    runRule(config, input, normalizedSeries, navLookup, timelineDates, checkDates, rule)
  );

  return {
    input,
    requestedStartDate: input.startDate,
    requestedEndDate: input.endDate,
    actualStartDate,
    actualEndDate,
    results
  };
};

const normalizeSeries = (
  config: PortfolioConfig,
  series: HoldingNavSeries[],
  startDate: string,
  endDate: string
): HoldingNavSeries[] => {
  const byHolding = new Map(series.map((item) => [item.holdingId, item]));
  return config.holdings.map((holding) => {
    if (holding.kind === "cash") {
      return {
        holdingId: holding.id,
        kind: "cash",
        name: holding.name,
        targetPercent: holding.targetPercent,
        points: [
          { date: startDate, nav: 1 },
          { date: endDate, nav: 1 }
        ]
      };
    }

    const matched = byHolding.get(holding.id);
    const points = [...(matched?.points ?? [])]
      .filter((point) => point.date >= startDate && point.date <= endDate && point.nav > 0)
      .sort((left, right) => left.date.localeCompare(right.date));
    if (points.length === 0) {
      throw new Error(`基金 ${holding.code ?? holding.name} 在期望区间内没有历史净值`);
    }
    return {
      holdingId: holding.id,
      kind: "fund",
      code: holding.code,
      name: matched?.name || holding.name,
      targetPercent: holding.targetPercent,
      points
    };
  });
};

const buildTimelineDates = (series: HoldingNavSeries[], startDate: string, endDate: string) => {
  const fundSeries = series.filter((item) => item.kind === "fund");
  if (fundSeries.length === 0) {
    return [startDate, endDate];
  }

  const actualStart = fundSeries.reduce((max, item) => maxDate(max, item.points[0]?.date ?? endDate), startDate);
  const actualEnd = fundSeries.reduce(
    (min, item) => minDate(min, item.points[item.points.length - 1]?.date ?? startDate),
    endDate
  );
  if (actualStart >= actualEnd) {
    return [];
  }

  return Array.from(
    new Set(
      fundSeries.flatMap((item) =>
        item.points.filter((point) => point.date >= actualStart && point.date <= actualEnd).map((point) => point.date)
      )
    )
  ).sort((left, right) => left.localeCompare(right));
};

const createNavLookup = (series: HoldingNavSeries[], dates: string[]): NavLookup => {
  const lookup: NavLookup = {};
  series.forEach((item) => {
    const map = new Map<string, number>();
    let cursor = 0;
    let lastNav = item.kind === "cash" ? 1 : Number.NaN;
    const points = item.points;
    dates.forEach((date) => {
      while (cursor < points.length && points[cursor].date <= date) {
        lastNav = points[cursor].nav;
        cursor += 1;
      }
      if (!Number.isFinite(lastNav)) {
        throw new Error(`${item.name} 在 ${date} 缺少可用净值`);
      }
      map.set(date, lastNav);
    });
    lookup[item.holdingId] = map;
  });
  return lookup;
};

const runRule = (
  config: PortfolioConfig,
  input: BacktestInput,
  series: HoldingNavSeries[],
  navLookup: NavLookup,
  dates: string[],
  checkDates: Record<BacktestFrequency, Set<string>>,
  rule: BacktestRule
): BacktestRuleResult => {
  const shares: SharesState = {};
  const firstDate = dates[0];
  config.holdings.forEach((holding) => {
    const nav = navLookup[holding.id].get(firstDate) ?? 1;
    const allocation = (input.initialAmount * holding.targetPercent) / 100;
    shares[holding.id] = allocation / nav;
  });

  let previousTotal = 0;
  let peak = 0;
  const timeline: BacktestTimelinePoint[] = [];
  const rebalanceRecords: BacktestRebalanceRecord[] = [];

  dates.forEach((date, index) => {
    const beforeState = evaluateHoldings(config, navLookup, shares, date);
    const totalValue = beforeState.reduce((sum, item) => sum + item.value, 0);
    const dailyReturn = index === 0 || previousTotal <= 0 ? 0 : totalValue / previousTotal - 1;
    const normalizedValue = totalValue / input.initialAmount;
    peak = Math.max(peak, normalizedValue);
    const drawdown = peak > 0 ? normalizedValue / peak - 1 : 0;

    timeline.push({
      date,
      totalValue,
      normalizedValue,
      dailyReturn,
      drawdown,
      holdings: beforeState
    });

    const trigger = shouldRebalance(rule, date, beforeState, checkDates);
    if (trigger.triggered && index < dates.length - 1) {
      rebalanceRecords.push(rebalance(config, series, navLookup, shares, date, rule, trigger.reason, beforeState));
    }

    previousTotal = totalValue;
  });

  return summarizeRule(rule, input, timeline, rebalanceRecords);
};

const evaluateHoldings = (
  config: PortfolioConfig,
  navLookup: NavLookup,
  shares: SharesState,
  date: string
): BacktestHoldingState[] => {
  const raw = config.holdings.map((holding) => {
    const nav = navLookup[holding.id].get(date) ?? 1;
    return {
      holdingId: holding.id,
      value: shares[holding.id] * nav,
      shares: shares[holding.id],
      nav,
      targetPercent: holding.targetPercent,
      currentPercent: 0,
      driftPercentPoints: 0,
      relativeDriftPercent: 0
    };
  });
  const totalValue = raw.reduce((sum, item) => sum + item.value, 0);
  return raw.map((item) => {
    const currentPercent = totalValue > 0 ? (item.value / totalValue) * 100 : 0;
    const driftPercentPoints = currentPercent - item.targetPercent;
    return {
      ...item,
      currentPercent,
      driftPercentPoints,
      relativeDriftPercent: item.targetPercent > 0 ? (driftPercentPoints / item.targetPercent) * 100 : 0
    };
  });
};

const shouldRebalance = (
  rule: BacktestRule,
  date: string,
  state: BacktestHoldingState[],
  checkDates: Record<BacktestFrequency, Set<string>>
) => {
  if (rule.type === "buy-and-hold") {
    return { triggered: false, reason: "" };
  }

  const frequencyHit = rule.frequency ? checkDates[rule.frequency].has(date) : false;
  const thresholdHit = state.some((item) => {
    if (rule.thresholdMode === "relative-percent") {
      return Math.abs(item.relativeDriftPercent) >= Number(rule.thresholdValue);
    }
    return Math.abs(item.driftPercentPoints) >= Number(rule.thresholdValue);
  });

  if (rule.type === "fixed-frequency" && frequencyHit) {
    return { triggered: true, reason: frequencyReason(rule.frequency) };
  }
  if (rule.type === "threshold" && thresholdHit) {
    return { triggered: true, reason: thresholdReason(rule) };
  }
  if (rule.type === "frequency-threshold" && frequencyHit && thresholdHit) {
    return { triggered: true, reason: `${frequencyReason(rule.frequency)}且${thresholdReason(rule)}` };
  }
  return { triggered: false, reason: "" };
};

const rebalance = (
  config: PortfolioConfig,
  series: HoldingNavSeries[],
  navLookup: NavLookup,
  shares: SharesState,
  date: string,
  rule: BacktestRule,
  reason: string,
  beforeState: BacktestHoldingState[]
): BacktestRebalanceRecord => {
  const beforeTotalValue = beforeState.reduce((sum, item) => sum + item.value, 0);
  let buyAmount = 0;
  let sellAmount = 0;
  const names = new Map(series.map((item) => [item.holdingId, item.name]));
  const items = config.holdings.map((holding) => {
    const before = beforeState.find((item) => item.holdingId === holding.id);
    const beforeValue = before?.value ?? 0;
    const afterValue = (beforeTotalValue * holding.targetPercent) / 100;
    const amount = afterValue - beforeValue;
    const nav = navLookup[holding.id].get(date) ?? 1;
    shares[holding.id] = afterValue / nav;
    if (amount > 0) {
      buyAmount += amount;
    } else {
      sellAmount += Math.abs(amount);
    }
    return {
      holdingId: holding.id,
      name: names.get(holding.id) ?? holding.name,
      amount,
      beforeValue,
      afterValue
    };
  });

  return {
    id: `${rule.id}:${date}:${rebalanceCounter++}`,
    date,
    ruleId: rule.id,
    ruleName: rule.name,
    triggerReason: reason,
    beforeTotalValue,
    turnoverAmount: Math.min(buyAmount, sellAmount),
    items
  };
};

let rebalanceCounter = 0;

const summarizeRule = (
  rule: BacktestRule,
  input: BacktestInput,
  timeline: BacktestTimelinePoint[],
  rebalanceRecords: BacktestRebalanceRecord[]
): BacktestRuleResult => {
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  const actualDays = Math.max(1, daysBetween(first.date, last.date));
  const finalAmount = last.totalValue;
  const cumulativeReturn = finalAmount / input.initialAmount - 1;
  const annualizedReturn = Math.pow(finalAmount / input.initialAmount, 365 / actualDays) - 1;
  const returns = timeline.slice(1).map((item) => item.dailyReturn);
  const annualizedVolatility = standardDeviation(returns) * Math.sqrt(252);
  const maxDrawdown = Math.min(...timeline.map((item) => item.drawdown));
  const riskFreeRate = input.riskFreeRatePercent / 100;
  const totalTurnoverAmount = rebalanceRecords.reduce((sum, item) => sum + item.turnoverAmount, 0);
  const averageValue = timeline.reduce((sum, item) => sum + item.totalValue, 0) / timeline.length;

  return {
    rule,
    finalAmount,
    cumulativeReturn,
    annualizedReturn,
    maxDrawdown,
    annualizedVolatility,
    sharpeRatio:
      annualizedVolatility > 0 ? (annualizedReturn - riskFreeRate) / annualizedVolatility : null,
    calmarRatio: maxDrawdown < 0 ? annualizedReturn / Math.abs(maxDrawdown) : null,
    returnDrawdownRatio: maxDrawdown < 0 ? cumulativeReturn / Math.abs(maxDrawdown) : null,
    dailyWinRate: returns.length > 0 ? returns.filter((item) => item > 0).length / returns.length : 0,
    bestDailyReturn: returns.length > 0 ? Math.max(...returns) : 0,
    worstDailyReturn: returns.length > 0 ? Math.min(...returns) : 0,
    maxDrawdownDays: calculateMaxDrawdownDays(timeline),
    rebalanceCount: rebalanceRecords.length,
    totalTurnoverAmount,
    annualizedTurnoverRate: averageValue > 0 ? (totalTurnoverAmount / averageValue / actualDays) * 365 : 0,
    averageRebalanceAmount: rebalanceRecords.length > 0 ? totalTurnoverAmount / rebalanceRecords.length : 0,
    timeline,
    rebalanceRecords
  };
};

const createFrequencyCheckDateSet = (dates: string[]): Record<BacktestFrequency, Set<string>> => ({
  monthly: new Set(groupLastDate(dates, (date) => date.slice(0, 7))),
  quarterly: new Set(groupLastDate(dates, (date) => `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`)),
  semiannual: new Set(groupLastDate(dates, (date) => `${date.slice(0, 4)}-H${Number(date.slice(5, 7)) <= 6 ? 1 : 2}`)),
  annual: new Set(groupLastDate(dates, (date) => date.slice(0, 4)))
});

const groupLastDate = (dates: string[], keyOf: (date: string) => string) => {
  const groups = new Map<string, string>();
  dates.forEach((date) => groups.set(keyOf(date), date));
  return Array.from(groups.values());
};

const frequencyReason = (frequency?: BacktestFrequency) =>
  frequency === "monthly"
    ? "月度检查"
    : frequency === "quarterly"
      ? "季度检查"
      : frequency === "semiannual"
        ? "半年检查"
        : "年度检查";

const thresholdReason = (rule: BacktestRule) =>
  rule.thresholdMode === "relative-percent"
    ? `相对偏离达到 ${rule.thresholdValue}%`
    : `偏离达到 ${rule.thresholdValue}pp`;

const standardDeviation = (values: number[]) => {
  if (values.length < 2) {
    return 0;
  }
  const average = values.reduce((sum, item) => sum + item, 0) / values.length;
  const variance = values.reduce((sum, item) => sum + Math.pow(item - average, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
};

const calculateMaxDrawdownDays = (timeline: BacktestTimelinePoint[]) => {
  let peakDate = timeline[0]?.date;
  let activePeakDate = peakDate;
  let peakValue = 0;
  let maxDays = 0;
  timeline.forEach((point) => {
    if (point.normalizedValue >= peakValue) {
      peakValue = point.normalizedValue;
      activePeakDate = point.date;
      return;
    }
    maxDays = Math.max(maxDays, daysBetween(activePeakDate, point.date));
  });
  return maxDays;
};

const daysBetween = (startDate: string, endDate: string) =>
  Math.round((new Date(`${endDate}T00:00:00`).getTime() - new Date(`${startDate}T00:00:00`).getTime()) / 86_400_000);

const minDate = (left: string, right: string) => (left <= right ? left : right);
const maxDate = (left: string, right: string) => (left >= right ? left : right);
