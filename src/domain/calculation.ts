import type {
  FundSnapshot,
  HistoricalNav,
  HoldingConfig,
  HoldingObservation,
  PortfolioConfig,
  PortfolioObservation,
  RebalanceStatus
} from "./types";

export type HoldingQuote =
  | {
      status: "ready";
      current: FundSnapshot;
      initial: HistoricalNav;
    }
  | {
      status: "failed";
      error: string;
      current?: FundSnapshot;
      initial?: HistoricalNav;
    };

export const calculatePortfolioObservation = (
  config: PortfolioConfig,
  quotes: Record<string, HoldingQuote>
): PortfolioObservation => {
  const preliminary = config.holdings.map((holding) => calculateHolding(config, holding, quotes));
  const totalMarketValue = preliminary.reduce((sum, item) => sum + item.marketValue, 0);
  const thresholds = normalizeThresholds(config);

  const holdings = preliminary.map((item) => {
    const currentPercent = totalMarketValue > 0 ? (item.marketValue / totalMarketValue) * 100 : 0;
    const driftPercentPoints = currentPercent - item.targetPercent;
    const relativeDriftPercent =
      item.targetPercent > 0 ? (driftPercentPoints / item.targetPercent) * 100 : 0;
    const targetValue = (totalMarketValue * item.targetPercent) / 100;
    const rebalanceAmount = targetValue - item.marketValue;
    return {
      ...item,
      targetValue,
      currentPercent,
      driftPercentPoints,
      relativeDriftPercent,
      rebalanceAmount,
      rebalanceStatus: item.error
        ? "error"
        : getRebalanceStatus(driftPercentPoints, relativeDriftPercent, thresholds)
    };
  });
  const totalRebalanceTurnover = holdings.reduce((sum, item) => sum + Math.abs(item.rebalanceAmount), 0) / 2;
  const portfolioDriftPercent =
    totalMarketValue > 0 ? (totalRebalanceTurnover / totalMarketValue) * 100 : 0;
  const rebalanceStatus = getPortfolioStatus(holdings.map((item) => item.rebalanceStatus), portfolioDriftPercent);

  return {
    totalMarketValue,
    profitAmount: totalMarketValue - config.totalAmount,
    profitRate: config.totalAmount > 0 ? (totalMarketValue - config.totalAmount) / config.totalAmount : 0,
    portfolioDriftPercent,
    rebalanceStatus,
    holdings
  };
};

const calculateHolding = (
  config: PortfolioConfig,
  holding: HoldingConfig,
  quotes: Record<string, HoldingQuote>
): HoldingObservation => {
  const initialAllocation = (config.totalAmount * holding.targetPercent) / 100;

  if (holding.kind === "cash") {
    return {
      holding,
      targetValue: initialAllocation,
      startNav: 1,
      currentNav: 1,
      shares: initialAllocation,
      marketValue: initialAllocation,
      targetPercent: holding.targetPercent,
      currentPercent: 0,
      driftPercentPoints: 0,
      relativeDriftPercent: 0,
      rebalanceAmount: 0,
      rebalanceStatus: "ok"
    };
  }

  const quote = holding.code ? quotes[holding.code] : undefined;
  if (!quote || quote.status === "failed") {
    return {
      holding,
      targetValue: initialAllocation,
      startNav: 0,
      currentNav: quote?.current?.nav ?? 0,
      shares: 0,
      marketValue: 0,
      targetPercent: holding.targetPercent,
      currentPercent: 0,
      driftPercentPoints: 0,
      relativeDriftPercent: 0,
      rebalanceAmount: initialAllocation,
      rebalanceStatus: "error",
      navDate: quote?.current?.navDate,
      error: quote?.error ?? "缺少基金代码"
    };
  }

  const shares = initialAllocation / quote.initial.nav;
  const marketValue = shares * quote.current.nav;

  return {
    holding: {
      ...holding,
      name: quote.current.name || holding.name
    },
    targetValue: initialAllocation,
    startNav: quote.initial.nav,
    currentNav: quote.current.nav,
    shares,
    marketValue,
    targetPercent: holding.targetPercent,
    currentPercent: 0,
    driftPercentPoints: 0,
    relativeDriftPercent: 0,
    rebalanceAmount: 0,
    rebalanceStatus: "ok",
    navDate: quote.current.navDate
  };
};

export const validatePortfolioConfig = (config: PortfolioConfig): string[] => {
  const errors: string[] = [];
  const name = config.name.trim();
  const totalTarget = config.holdings.reduce((sum, item) => sum + Number(item.targetPercent || 0), 0);
  const codes = config.holdings
    .filter((item) => item.kind === "fund")
    .map((item) => item.code?.trim())
    .filter((code): code is string => Boolean(code));
  const duplicateCode = codes.find((code, index) => codes.indexOf(code) !== index);

  if (!name) {
    errors.push("配置名称不能为空");
  }
  if (!(config.totalAmount > 0)) {
    errors.push("总金额必须大于 0");
  }
  if (config.holdings.length === 0) {
    errors.push("至少添加 1 个持仓项");
  }
  if (Math.abs(totalTarget - 100) > 0.0001) {
    errors.push("目标比例总和必须等于 100");
  }
  if (duplicateCode) {
    errors.push(`基金代码不可重复：${duplicateCode}`);
  }
  if (!(normalizeThresholds(config).absolutePercentPoints > 0)) {
    errors.push("pp 阈值必须大于 0");
  }
  if (!(normalizeThresholds(config).relativePercent > 0)) {
    errors.push("相对偏离阈值必须大于 0");
  }

  return errors;
};

export const DEFAULT_THRESHOLDS = {
  absolutePercentPoints: 5,
  relativePercent: 25
};

export const normalizeThresholds = (config: PortfolioConfig) => ({
  absolutePercentPoints:
    config.thresholds?.absolutePercentPoints && config.thresholds.absolutePercentPoints > 0
      ? config.thresholds.absolutePercentPoints
      : DEFAULT_THRESHOLDS.absolutePercentPoints,
  relativePercent:
    config.thresholds?.relativePercent && config.thresholds.relativePercent > 0
      ? config.thresholds.relativePercent
      : DEFAULT_THRESHOLDS.relativePercent
});

const getRebalanceStatus = (
  driftPercentPoints: number,
  relativeDriftPercent: number,
  thresholds: ReturnType<typeof normalizeThresholds>
): RebalanceStatus => {
  const absPp = Math.abs(driftPercentPoints);
  const absRelative = Math.abs(relativeDriftPercent);

  if (absPp >= thresholds.absolutePercentPoints || absRelative >= thresholds.relativePercent) {
    return "rebalance";
  }
  if (absPp >= thresholds.absolutePercentPoints / 2 || absRelative >= thresholds.relativePercent / 2) {
    return "watch";
  }
  return "ok";
};

const getPortfolioStatus = (
  holdingStatuses: RebalanceStatus[],
  portfolioDriftPercent: number
): RebalanceStatus => {
  if (holdingStatuses.includes("rebalance") || portfolioDriftPercent >= 5) {
    return "rebalance";
  }
  if (holdingStatuses.includes("watch") || portfolioDriftPercent >= 2.5) {
    return "watch";
  }
  if (holdingStatuses.includes("error")) {
    return "error";
  }
  return "ok";
};
