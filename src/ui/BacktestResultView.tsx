import { useMemo, useState } from "react";
import type { BacktestResult, BacktestRuleResult } from "../domain/backtestTypes";

const COLORS = ["#365f91", "#c9892b", "#6f8f52", "#9b4d55", "#4f7f7b", "#8b6bb1"];

export const BacktestResultView = ({
  result,
  activeTab,
  onTabChange
}: {
  result: BacktestResult;
  activeTab: "metrics" | "charts" | "records";
  onTabChange: (tab: "metrics" | "charts" | "records") => void;
}) => (
  <section className="backtest-result">
    <header className="backtest-result-head">
      <div>
        <strong>期望区间 {result.requestedStartDate} 至 {result.requestedEndDate}</strong>
        <span>实际区间 {result.actualStartDate} 至 {result.actualEndDate}</span>
        <span>无风险收益率 {result.input.riskFreeRatePercent.toFixed(2)}%</span>
      </div>
      <p>回测仅代表历史模拟，不代表未来表现；本期结果不含交易费用。</p>
    </header>
    <div className="observe-switch backtest-tabs" role="tablist" aria-label="回测结果">
      <button className={activeTab === "metrics" ? "active" : ""} onClick={() => onTabChange("metrics")}>
        指标
      </button>
      <button className={activeTab === "charts" ? "active" : ""} onClick={() => onTabChange("charts")}>
        曲线
      </button>
      <button className={activeTab === "records" ? "active" : ""} onClick={() => onTabChange("records")}>
        调仓
      </button>
    </div>
    {activeTab === "metrics" ? <MetricTables results={result.results} /> : null}
    {activeTab === "charts" ? <ChartTab results={result.results} /> : null}
    {activeTab === "records" ? <RecordTab results={result.results} /> : null}
  </section>
);

const MetricTables = ({ results }: { results: BacktestRuleResult[] }) => (
  <div className="backtest-metrics">
    <MetricTable
      title="核心指标"
      results={results}
      columns={[
        ["期末金额", (item) => formatMoney(item.finalAmount)],
        ["累计收益", (item) => formatPercent(item.cumulativeReturn)],
        ["年化收益", (item) => formatPercent(item.annualizedReturn)],
        ["最大回撤", (item) => formatPercent(item.maxDrawdown)]
      ]}
    />
    <MetricTable
      title="风险调整"
      results={results}
      columns={[
        ["波动率", (item) => formatPercent(item.annualizedVolatility)],
        ["夏普", (item) => formatNullable(item.sharpeRatio)],
        ["卡玛", (item) => formatNullable(item.calmarRatio)],
        ["收益回撤比", (item) => formatNullable(item.returnDrawdownRatio)]
      ]}
    />
    <MetricTable
      title="调仓统计"
      results={results}
      columns={[
        ["次数", (item) => String(item.rebalanceCount)],
        ["总金额", (item) => formatMoney(item.totalTurnoverAmount)],
        ["年化换手", (item) => formatPercent(item.annualizedTurnoverRate)],
        ["平均单次", (item) => formatMoney(item.averageRebalanceAmount)]
      ]}
    />
    <MetricTable
      title="扩展指标"
      results={results}
      columns={[
        ["日胜率", (item) => formatPercent(item.dailyWinRate)],
        ["最佳单日", (item) => formatPercent(item.bestDailyReturn)],
        ["最差单日", (item) => formatPercent(item.worstDailyReturn)],
        ["最长回撤", (item) => `${item.maxDrawdownDays} 天`]
      ]}
    />
  </div>
);

const MetricTable = ({
  title,
  results,
  columns
}: {
  title: string;
  results: BacktestRuleResult[];
  columns: Array<[string, (result: BacktestRuleResult) => string]>;
}) => (
  <section className="backtest-table-card">
    <h3>{title}</h3>
    <div className="backtest-table">
      <div className="backtest-table-row head">
        <span>规则</span>
        {columns.map(([label]) => <span key={label}>{label}</span>)}
      </div>
      {results.map((item, index) => (
        <div className="backtest-table-row" key={item.rule.id}>
          <strong><i style={{ background: COLORS[index % COLORS.length] }} />{item.rule.name}</strong>
          {columns.map(([label, render]) => (
            <span className={toneClass(metricTone(label, item))} key={label}>{render(item)}</span>
          ))}
        </div>
      ))}
    </div>
  </section>
);

const ChartTab = ({ results }: { results: BacktestRuleResult[] }) => {
  const [mode, setMode] = useState<"return" | "drawdown">("return");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = results.filter((item) => !hidden.has(item.rule.id));

  return (
    <section className="backtest-chart-card">
      <div className="chart-toolbar">
        <div className="observe-switch">
          <button className={mode === "return" ? "active" : ""} onClick={() => setMode("return")}>收益曲线</button>
          <button className={mode === "drawdown" ? "active" : ""} onClick={() => setMode("drawdown")}>回撤曲线</button>
        </div>
      </div>
      <LineChart results={visible} mode={mode} />
      <div className="chart-legend">
        {results.map((item, index) => (
          <button
            key={item.rule.id}
            className={hidden.has(item.rule.id) ? "muted" : ""}
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(item.rule.id)) {
                  next.delete(item.rule.id);
                } else {
                  next.add(item.rule.id);
                }
                return next;
              })
            }
          >
            <i style={{ background: COLORS[index % COLORS.length] }} />
            {item.rule.name}
          </button>
        ))}
      </div>
    </section>
  );
};

const LineChart = ({ results, mode }: { results: BacktestRuleResult[]; mode: "return" | "drawdown" }) => {
  const values = results.flatMap((result) =>
    result.timeline.map((point) => (mode === "return" ? point.normalizedValue : point.drawdown))
  );
  const min = mode === "return" ? Math.min(1, ...values) : Math.min(...values, 0);
  const max = mode === "return" ? Math.max(...values, 1) : 0;
  const width = 620;
  const height = 220;
  const pad = 28;
  const range = max - min || 1;

  if (results.length === 0) {
    return <div className="empty-visual">请选择至少一条规则</div>;
  }

  return (
    <svg className="backtest-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={mode === "return" ? "收益曲线" : "回撤曲线"}>
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} />
      {results.map((result, index) => {
        const points = result.timeline.map((point, pointIndex) => {
          const x = pad + (pointIndex / Math.max(1, result.timeline.length - 1)) * (width - pad * 2);
          const value = mode === "return" ? point.normalizedValue : point.drawdown;
          const y = height - pad - ((value - min) / range) * (height - pad * 2);
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        });
        return (
          <polyline
            key={result.rule.id}
            points={points.join(" ")}
            fill="none"
            stroke={COLORS[index % COLORS.length]}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      <text x={pad} y={18}>{mode === "return" ? max.toFixed(2) : formatPercent(max)}</text>
      <text x={pad} y={height - 6}>{mode === "return" ? min.toFixed(2) : formatPercent(min)}</text>
    </svg>
  );
};

const RecordTab = ({ results }: { results: BacktestRuleResult[] }) => {
  const [ruleId, setRuleId] = useState(results[0]?.rule.id ?? "");
  const selected = useMemo(
    () => results.find((item) => item.rule.id === ruleId) ?? results[0],
    [results, ruleId]
  );
  const records = selected?.rebalanceRecords ?? [];

  return (
    <section className="backtest-records">
      <label>
        规则
        <select value={selected?.rule.id ?? ""} onChange={(event) => setRuleId(event.target.value)}>
          {results.map((item) => <option key={item.rule.id} value={item.rule.id}>{item.rule.name}</option>)}
        </select>
      </label>
      {records.length === 0 ? <div className="empty-visual">该规则在回测区间内没有触发再平衡。</div> : null}
      {records.map((record) => (
        <article className="backtest-record" key={record.id}>
          <header>
            <strong>{record.date}</strong>
            <span>{record.triggerReason}</span>
          </header>
          <p>调仓前市值 {formatMoney(record.beforeTotalValue)} · 换手 {formatMoney(record.turnoverAmount)}</p>
          <div>
            {record.items.map((item) => (
              <span className={toneClass(item.amount)} key={item.holdingId}>
                {item.name} {item.amount >= 0 ? "买入" : "卖出"} {formatMoney(Math.abs(item.amount))}
              </span>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
};

const metricTone = (label: string, result: BacktestRuleResult) => {
  if (label.includes("收益") || label === "最佳单日") {
    return result.cumulativeReturn;
  }
  if (label.includes("回撤") || label === "最差单日") {
    return result.maxDrawdown;
  }
  return 0;
};

const formatMoney = (value: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(value);
const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`;
const formatNullable = (value: number | null) => (value === null ? "--" : value.toFixed(2));
const toneClass = (value: number) => (value > 0 ? "positive" : value < 0 ? "negative" : "neutral");
