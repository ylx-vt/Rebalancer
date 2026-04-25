import { useMemo, useState } from "react";
import { Check, Copy, LoaderCircle, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { runBacktest, validateBacktestInput } from "../domain/backtest";
import type { BacktestInput, BacktestResult, BacktestRule } from "../domain/backtestTypes";
import type { AppState, PortfolioConfig } from "../domain/types";
import { loadHistoricalNavSeriesForConfig } from "../services/historicalNavSeries";
import { BacktestResultView } from "./BacktestResultView";

type BacktestRunState =
  | { status: "idle" }
  | { status: "loading-data" }
  | { status: "success"; result: BacktestResult }
  | { status: "error"; message: string };

interface BacktestPanelProps {
  config?: PortfolioConfig;
  state: AppState;
  onStatePatch: (updater: (current: AppState) => AppState) => void;
  onBack: () => void;
}

const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const today = () => new Date().toISOString().slice(0, 10);

export const BacktestPanel = ({ config, state, onStatePatch, onBack }: BacktestPanelProps) => {
  const initialInput = useMemo(() => createInitialInput(config, state.lastBacktestInput), [config?.id]);
  const [input, setInput] = useState<BacktestInput>(initialInput);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [runState, setRunState] = useState<BacktestRunState>({ status: "idle" });
  const [activeTab, setActiveTab] = useState<"metrics" | "charts" | "records">("metrics");
  const errors = useMemo(() => validateBacktestInput(config, input), [config, input]);

  const run = async () => {
    if (!config) {
      setRunState({ status: "error", message: "还没有可用于回测的配置" });
      return;
    }
    if (errors.length > 0) {
      setRunState({ status: "error", message: errors[0] });
      return;
    }

    setRunState({ status: "loading-data" });
    onStatePatch((current) => ({ ...current, lastBacktestInput: input }));
    try {
      const loaded = await loadHistoricalNavSeriesForConfig(
        config,
        state,
        input.startDate,
        input.endDate,
        forceRefresh
      );
      const result = runBacktest(config, input, loaded.series);
      onStatePatch((current) => ({
        ...current,
        historicalSeriesCache: { ...(current.historicalSeriesCache ?? {}), ...loaded.cachePatch },
        lastBacktestInput: input
      }));
      setActiveTab("metrics");
      setRunState({ status: "success", result });
    } catch (error) {
      setRunState({ status: "error", message: readError(error) });
    }
  };

  if (!config) {
    return (
      <div className="blank-state">
        <h2>还没有可用于回测的配置</h2>
        <p>请先创建至少包含 1 个基金持仓的配置。</p>
      </div>
    );
  }

  return (
    <div className="panel backtest-panel">
      <div className="panel-title">
        <div>
          <h2>规则回测</h2>
          <p>{config.name} · {config.holdings.length} 个持仓 · 目标比例 {sumTarget(config).toFixed(2)}%</p>
        </div>
        <div className="inline-actions">
          <button className="secondary" onClick={onBack}>返回观测</button>
        </div>
      </div>

      <section className="backtest-form-card">
        <div className="form-grid">
          <label>
            期望开始日期
            <input
              type="date"
              value={input.startDate}
              onChange={(event) => setInput({ ...input, startDate: event.target.value })}
            />
          </label>
          <label>
            期望结束日期
            <input
              type="date"
              value={input.endDate}
              onChange={(event) => setInput({ ...input, endDate: event.target.value })}
            />
          </label>
          <label>
            初始金额
            <input
              type="number"
              min="1"
              value={input.initialAmount}
              onChange={(event) => setInput({ ...input, initialAmount: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="backtest-advanced">
          <label>
            无风险收益率
            <input
              type="number"
              step="0.1"
              value={input.riskFreeRatePercent}
              onChange={(event) => setInput({ ...input, riskFreeRatePercent: Number(event.target.value) })}
            />
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={forceRefresh} onChange={(event) => setForceRefresh(event.target.checked)} />
            强制刷新历史数据
          </label>
        </div>
      </section>

      <section className="backtest-rules">
        <div className="section-head">
          <h3>规则</h3>
          <span>{input.rules.length}/6</span>
        </div>
        <div className="backtest-rule-list">
          {input.rules.map((rule) => (
            <BacktestRuleCard
              key={rule.id}
              rule={rule}
              canDelete={input.rules.length > 1}
              onChange={(nextRule) =>
                setInput({
                  ...input,
                  rules: input.rules.map((item) => (item.id === rule.id ? nextRule : item))
                })
              }
              onCopy={() =>
                input.rules.length < 6 &&
                setInput({
                  ...input,
                  rules: [...input.rules, { ...rule, id: uid(), name: `${rule.name} 副本` }]
                })
              }
              onDelete={() =>
                input.rules.length > 1 &&
                setInput({ ...input, rules: input.rules.filter((item) => item.id !== rule.id) })
              }
            />
          ))}
        </div>
        <button
          className="secondary"
          onClick={() => setInput({ ...input, rules: [...input.rules, createRule(input.rules.length + 1)] })}
          disabled={input.rules.length >= 6}
        >
          <Plus size={15} />
          添加规则
        </button>
      </section>

      {errors.length > 0 || runState.status === "error" ? (
        <div className="panel-feedback error">{runState.status === "error" ? runState.message : errors[0]}</div>
      ) : null}

      <button
        className="save-button backtest-run-button"
        onClick={() => void run()}
        disabled={runState.status === "loading-data" || errors.length > 0}
      >
        {runState.status === "loading-data" ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
        {runState.status === "loading-data" ? "加载历史净值" : "运行回测"}
      </button>

      {runState.status === "loading-data" ? (
        <div className="backtest-loading">
          <RefreshCw size={16} className="spin" />
          正在加载历史净值并计算最大可回测区间
        </div>
      ) : null}

      {runState.status === "success" ? (
        <BacktestResultView result={runState.result} activeTab={activeTab} onTabChange={setActiveTab} />
      ) : null}
    </div>
  );
};

const BacktestRuleCard = ({
  rule,
  canDelete,
  onChange,
  onCopy,
  onDelete
}: {
  rule: BacktestRule;
  canDelete: boolean;
  onChange: (rule: BacktestRule) => void;
  onCopy: () => void;
  onDelete: () => void;
}) => {
  const needsFrequency = rule.type === "fixed-frequency" || rule.type === "frequency-threshold";
  const needsThreshold = rule.type === "threshold" || rule.type === "frequency-threshold";

  return (
    <article className="backtest-rule-card">
      <div className="backtest-rule-head">
        <input value={rule.name} onChange={(event) => onChange({ ...rule, name: event.target.value })} />
        <button title="复制规则" onClick={onCopy}>
          <Copy size={14} />
        </button>
        <button title="删除规则" onClick={onDelete} disabled={!canDelete}>
          <Trash2 size={14} />
        </button>
      </div>
      <div className="backtest-rule-grid">
        <label>
          类型
          <select
            value={rule.type}
            onChange={(event) => onChange(normalizeRuleForType(rule, event.target.value as BacktestRule["type"]))}
          >
            <option value="buy-and-hold">不再平衡</option>
            <option value="fixed-frequency">固定频率再平衡</option>
            <option value="threshold">阈值触发再平衡</option>
            <option value="frequency-threshold">固定频率检查 + 阈值触发</option>
          </select>
        </label>
        {needsFrequency ? (
          <label>
            频率
            <select value={rule.frequency ?? "monthly"} onChange={(event) => onChange({ ...rule, frequency: event.target.value as BacktestRule["frequency"] })}>
              <option value="monthly">每月</option>
              <option value="quarterly">每季度</option>
              <option value="semiannual">每半年</option>
              <option value="annual">每年</option>
            </select>
          </label>
        ) : null}
        {needsThreshold ? (
          <>
            <label>
              阈值
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={rule.thresholdValue ?? 5}
                onChange={(event) => onChange({ ...rule, thresholdValue: Number(event.target.value) })}
              />
            </label>
            <label>
              模式
              <select
                value={rule.thresholdMode ?? "absolute-pp"}
                onChange={(event) => onChange({ ...rule, thresholdMode: event.target.value as BacktestRule["thresholdMode"] })}
              >
                <option value="absolute-pp">pp 偏离</option>
                <option value="relative-percent">相对偏离 %</option>
              </select>
            </label>
          </>
        ) : null}
      </div>
    </article>
  );
};

const createInitialInput = (config?: PortfolioConfig, last?: BacktestInput): BacktestInput => {
  const configId = config?.id ?? "";
  if (last?.configId === configId) {
    return structuredClone(last);
  }
  const endDate = today();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 3);
  return {
    configId,
    startDate: startDate.toISOString().slice(0, 10),
    endDate,
    initialAmount: config?.totalAmount ?? 100000,
    riskFreeRatePercent: 2,
    rules: [
      { id: uid(), name: "不再平衡", type: "buy-and-hold" },
      { id: uid(), name: "月度再平衡", type: "fixed-frequency", frequency: "monthly" },
      { id: uid(), name: "偏离 5pp 触发", type: "threshold", thresholdMode: "absolute-pp", thresholdValue: 5 }
    ]
  };
};

const createRule = (index: number): BacktestRule => ({
  id: uid(),
  name: `新规则 ${index}`,
  type: "threshold",
  thresholdMode: "absolute-pp",
  thresholdValue: 5
});

const normalizeRuleForType = (rule: BacktestRule, type: BacktestRule["type"]): BacktestRule => ({
  ...rule,
  type,
  frequency: type === "fixed-frequency" || type === "frequency-threshold" ? rule.frequency ?? "monthly" : undefined,
  thresholdMode: type === "threshold" || type === "frequency-threshold" ? rule.thresholdMode ?? "absolute-pp" : undefined,
  thresholdValue: type === "threshold" || type === "frequency-threshold" ? rule.thresholdValue ?? 5 : undefined
});

const sumTarget = (config: PortfolioConfig) =>
  config.holdings.reduce((sum, holding) => sum + Number(holding.targetPercent || 0), 0);

const readError = (error: unknown) => (error instanceof Error ? error.message : "回测失败");
