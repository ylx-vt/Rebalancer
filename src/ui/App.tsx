import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { Check, Plus, RefreshCw, Save, Star, Trash2, Upload } from "lucide-react";
import {
  DEFAULT_THRESHOLDS,
  calculatePortfolioObservation,
  validatePortfolioConfig
} from "../domain/calculation";
import { parseFundImport } from "../domain/importers";
import type {
  AppState,
  FundSnapshot,
  HoldingConfig,
  PortfolioConfig,
  PortfolioObservation
} from "../domain/types";
import { getCachedSnapshot, loadQuotesForConfig } from "../services/fundClient";
import { createInitialState, loadState, saveState } from "../services/storage";

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const createEmptyConfig = (): PortfolioConfig => ({
  id: uid(),
  name: "",
  totalAmount: 100000,
  startDate: today(),
  thresholds: DEFAULT_THRESHOLDS,
  holdings: [],
  createdAt: Date.now(),
  updatedAt: Date.now()
});

const createFundHolding = (code = ""): HoldingConfig => ({
  id: uid(),
  kind: "fund",
  code,
  name: code,
  targetPercent: 0
});

const createCashHolding = (): HoldingConfig => ({
  id: uid(),
  kind: "cash",
  name: "现金",
  targetPercent: 0
});

type SortKey = "holding" | "target" | "current" | "drift" | "rebalance";
type SortDirection = "asc" | "desc";

export const App = () => {
  const [state, setState] = useState<AppState>(createInitialState);
  const [form, setForm] = useState<PortfolioConfig>(createEmptyConfig);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<"observe" | "edit">("edit");
  const [observation, setObservation] = useState<PortfolioObservation | null>(null);
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [loadingNameIds, setLoadingNameIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [importText, setImportText] = useState("");

  const selectedConfig = useMemo(
    () => state.configs.find((config) => config.id === state.selectedConfigId) ?? state.configs[0],
    [state.configs, state.selectedConfigId]
  );
  const validationErrors = useMemo(() => validatePortfolioConfig(form), [form]);
  const targetSum = useMemo(
    () => form.holdings.reduce((sum, holding) => sum + Number(holding.targetPercent || 0), 0),
    [form.holdings]
  );

  useEffect(() => {
    loadState().then((nextState) => {
      const selectedConfigId =
        nextState.selectedConfigId ?? nextState.primaryConfigId ?? nextState.configs[0]?.id;
      setState({ ...nextState, selectedConfigId });
      const config = nextState.configs.find((item) => item.id === selectedConfigId);
      setForm(config ? structuredClone(config) : createEmptyConfig());
      setActiveTab(config ? "observe" : "edit");
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    saveState(state).catch((error) => setMessage(readError(error)));
  }, [loaded, state]);

  useEffect(() => {
    if (!selectedConfig) {
      setObservation(null);
      return;
    }
    setForm(structuredClone(selectedConfig));
    void refreshObservation(selectedConfig, false);
  }, [selectedConfig?.id]);

  const patchState = (updater: (current: AppState) => AppState) => {
    setState((current) => updater(current));
  };

  const refreshObservation = async (config = selectedConfig, forceRefresh = true) => {
    if (!config) {
      return;
    }

    setLoadingQuotes(true);
    setMessage(forceRefresh ? "正在刷新净值" : "");
    const result = await loadQuotesForConfig(config, state, forceRefresh);
    const nextObservation = calculatePortfolioObservation(config, result.quotes);

    setObservation(nextObservation);
    patchState((current) => ({
      ...current,
      fundCache: { ...current.fundCache, ...result.fundCachePatch },
      historicalCache: { ...current.historicalCache, ...result.historicalCachePatch }
    }));
    setLoadingQuotes(false);
    setMessage(forceRefresh ? "净值已刷新" : "");
  };

  const saveCurrentConfig = async () => {
    const errors = validatePortfolioConfig(form);
    if (errors.length > 0) {
      setMessage(errors[0]);
      return;
    }

    const holdings = await Promise.all(
      form.holdings.map(async (holding) => {
        const code = holding.code?.trim();
        if (holding.kind !== "fund" || !code) {
          return {
            ...holding,
            code,
            name: holding.name.trim() || "现金",
            targetPercent: Number(holding.targetPercent)
          };
        }

        const shouldCompleteName = !holding.name.trim() || holding.name.trim() === code;
        if (!shouldCompleteName) {
          return {
            ...holding,
            code,
            name: holding.name.trim(),
            targetPercent: Number(holding.targetPercent)
          };
        }

        try {
          const snapshot = await getCachedSnapshot(code, state, false);
          return {
            ...holding,
            code,
            name: snapshot.name,
            targetPercent: Number(holding.targetPercent)
          };
        } catch {
          return {
            ...holding,
            code,
            name: code,
            targetPercent: Number(holding.targetPercent)
          };
        }
      })
    );

    const normalized: PortfolioConfig = {
      ...form,
      name: form.name.trim(),
      thresholds: {
        absolutePercentPoints: Number(
          form.thresholds?.absolutePercentPoints || DEFAULT_THRESHOLDS.absolutePercentPoints
        ),
        relativePercent: Number(form.thresholds?.relativePercent || DEFAULT_THRESHOLDS.relativePercent)
      },
      holdings,
      updatedAt: Date.now()
    };

    patchState((current) => {
      const exists = current.configs.some((config) => config.id === normalized.id);
      const configs = exists
        ? current.configs.map((config) => (config.id === normalized.id ? normalized : config))
        : [...current.configs, normalized];
      return {
        ...current,
        configs,
        selectedConfigId: normalized.id,
        primaryConfigId: current.primaryConfigId ?? normalized.id
      };
    });
    setActiveTab("observe");
    setMessage("配置已保存");
    void refreshObservation(normalized, true);
  };

  const selectConfig = (config: PortfolioConfig) => {
    patchState((current) => ({ ...current, selectedConfigId: config.id }));
    setActiveTab("observe");
    setMessage("");
  };

  const deleteConfig = (id: string) => {
    patchState((current) => {
      const configs = current.configs.filter((config) => config.id !== id);
      const selectedConfigId =
        current.selectedConfigId === id ? current.primaryConfigId ?? configs[0]?.id : current.selectedConfigId;
      return {
        ...current,
        configs,
        selectedConfigId,
        primaryConfigId: current.primaryConfigId === id ? configs[0]?.id : current.primaryConfigId
      };
    });
    setObservation(null);
    setForm(createEmptyConfig());
    setMessage("配置已删除");
  };

  const setPrimary = (id: string) => {
    patchState((current) => ({ ...current, primaryConfigId: id, selectedConfigId: id }));
    setMessage("已设为主配置");
  };

  const updateHolding = (id: string, patch: Partial<HoldingConfig>) => {
    setForm((current) => ({
      ...current,
      holdings: current.holdings.map((holding) =>
        holding.id === id
          ? {
              ...holding,
              ...patch
            }
          : holding
      )
    }));
  };

  const markNameLoading = (ids: string[], loading: boolean) => {
    setLoadingNameIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => {
        if (loading) {
          next.add(id);
        } else {
          next.delete(id);
        }
      });
      return next;
    });
  };

  const completeFundNames = async (holdings: HoldingConfig[]) => {
    const fundHoldings = holdings.filter((holding) => holding.kind === "fund" && holding.code?.trim());
    if (fundHoldings.length === 0) {
      return;
    }

    markNameLoading(
      fundHoldings.map((holding) => holding.id),
      true
    );
    setMessage(fundHoldings.length > 1 ? "正在补全基金名称" : "正在查询基金名称");

    const results = await Promise.all(
      fundHoldings.map(async (holding) => {
        const code = holding.code!.trim();
        try {
          const snapshot = await getCachedSnapshot(code, state, false);
          return { holdingId: holding.id, code, snapshot };
        } catch (error) {
          return { holdingId: holding.id, code, error: readError(error) };
        }
      })
    );

    const snapshots = results.filter(
      (item): item is { holdingId: string; code: string; snapshot: FundSnapshot } => "snapshot" in item
    );
    const failures = results.filter((item) => "error" in item);

    if (snapshots.length > 0) {
      patchState((current) => ({
        ...current,
        fundCache: {
          ...current.fundCache,
          ...Object.fromEntries(snapshots.map((item) => [item.code, item.snapshot]))
        }
      }));
      setForm((current) => ({
        ...current,
        holdings: current.holdings.map((holding) => {
          const result = snapshots.find((item) => item.holdingId === holding.id);
          if (!result || holding.kind !== "fund" || holding.code?.trim() !== result.code) {
            return holding;
          }
          return {
            ...holding,
            name: result.snapshot.name
          };
        })
      }));
    }

    markNameLoading(
      fundHoldings.map((holding) => holding.id),
      false
    );

    if (failures.length > 0) {
      setMessage(`有 ${failures.length} 只基金名称查询失败，可稍后重试`);
      return;
    }
    setMessage(`已补全 ${snapshots.length} 只基金名称`);
  };

  const completeFundName = async (holdingId: string) => {
    const holding = form.holdings.find((item) => item.id === holdingId);
    if (!holding || holding.kind !== "fund" || !holding.code?.trim()) {
      return;
    }
    await completeFundNames([holding]);
  };

  const importCodes = async (text: string) => {
    try {
      const result = parseFundImport(text);
      const existingCodes = new Set(
        form.holdings.map((holding) => holding.code).filter((code): code is string => Boolean(code))
      );
      const newHoldings = result.codes
        .filter((code) => !existingCodes.has(code))
        .map((code) => createFundHolding(code));
      setForm((current) => ({ ...current, holdings: [...current.holdings, ...newHoldings] }));
      setMessage(`已导入 ${newHoldings.length} 只基金，格式：${result.parserName}`);
      setImportText("");
      void completeFundNames(newHoldings);
    } catch (error) {
      setMessage(readError(error));
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await importCodes(await file.text());
    event.target.value = "";
  };

  if (!loaded) {
    return <div className="boot">Rebalancer</div>;
  }

  return (
    <main className="app-shell">
      <aside className="config-rail">
        <header>
          <div className="brand-mark">
            <img src="/icons/logo.svg" alt="" />
          </div>
          <div>
            <h1>Rebalancer</h1>
            <p>再平衡观测</p>
          </div>
        </header>

        <button className="new-config" onClick={() => {
          setForm(createEmptyConfig());
          setActiveTab("edit");
          setObservation(null);
        }}>
          <Plus size={16} />
          新建配置
        </button>

        <div className="config-list">
          {state.configs.map((config) => (
            <button
              key={config.id}
              className={`config-item ${config.id === state.selectedConfigId ? "active" : ""}`}
              onClick={() => selectConfig(config)}
            >
              <span>{config.name}</span>
              {config.id === state.primaryConfigId ? <Star size={14} fill="currentColor" /> : null}
            </button>
          ))}
          {state.configs.length === 0 ? <p className="empty">暂无配置</p> : null}
        </div>
      </aside>

      <section className="workspace">
        <nav className="tabs">
          <button className={activeTab === "observe" ? "active" : ""} onClick={() => setActiveTab("observe")}>
            观测
          </button>
          <button className={activeTab === "edit" ? "active" : ""} onClick={() => setActiveTab("edit")}>
            录入
          </button>
        </nav>

        {message ? <div className="notice">{message}</div> : null}

        {activeTab === "observe" ? (
          <ObservePanel
            config={selectedConfig}
            observation={observation}
            loading={loadingQuotes}
            isPrimary={selectedConfig?.id === state.primaryConfigId}
            onRefresh={() => void refreshObservation(selectedConfig, true)}
            onEdit={() => setActiveTab("edit")}
            onPrimary={() => selectedConfig && setPrimary(selectedConfig.id)}
            onDelete={() => selectedConfig && deleteConfig(selectedConfig.id)}
          />
        ) : (
          <EditPanel
            form={form}
            targetSum={targetSum}
            errors={validationErrors}
            importText={importText}
            setImportText={setImportText}
            onChange={setForm}
            onSave={() => void saveCurrentConfig()}
            onImport={() => void importCodes(importText)}
            onFileImport={importFile}
            loadingNameIds={loadingNameIds}
            onAddFund={() =>
              setForm((current) => ({ ...current, holdings: [...current.holdings, createFundHolding()] }))
            }
            onAddCash={() =>
              setForm((current) => ({ ...current, holdings: [...current.holdings, createCashHolding()] }))
            }
            onUpdateHolding={updateHolding}
            onCompleteFundName={(id) => void completeFundName(id)}
            onRemoveHolding={(id) =>
              setForm((current) => ({
                ...current,
                holdings: current.holdings.filter((holding) => holding.id !== id)
              }))
            }
          />
        )}
      </section>
    </main>
  );
};

interface ObservePanelProps {
  config?: PortfolioConfig;
  observation: PortfolioObservation | null;
  loading: boolean;
  isPrimary: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onPrimary: () => void;
  onDelete: () => void;
}

const ObservePanel = ({
  config,
  observation,
  loading,
  isPrimary,
  onRefresh,
  onEdit,
  onPrimary,
  onDelete
}: ObservePanelProps) => {
  const [sortKey, setSortKey] = useState<SortKey>("target");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const sortedHoldings = useMemo(() => {
    const holdings = [...(observation?.holdings ?? [])];
    return holdings.sort((left, right) => {
      const delta = getSortValue(left, sortKey).localeCompare(getSortValue(right, sortKey), "zh-CN", {
        numeric: true
      });
      const numericDelta = getNumericSortValue(left, sortKey) - getNumericSortValue(right, sortKey);
      const result = sortKey === "holding" ? delta : numericDelta;
      return sortDirection === "asc" ? result : -result;
    });
  }, [observation?.holdings, sortDirection, sortKey]);

  const changeSort = (nextKey: SortKey) => {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "holding" ? "asc" : "desc");
  };

  if (!config) {
    return (
      <div className="blank-state">
        <h2>还没有配置</h2>
        <p>新建一个配置后即可查看偏离与建议调仓金额。</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <div>
          <h2>{config.name}</h2>
          <p>{config.startDate} 起 · {formatMoney(config.totalAmount)}</p>
        </div>
        <div className="icon-actions">
          <button title="刷新净值" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
          <button title="设为主配置" onClick={onPrimary} className={isPrimary ? "selected" : ""}>
            <Star size={16} fill={isPrimary ? "currentColor" : "none"} />
          </button>
          <button title="编辑" onClick={onEdit}>
            <Save size={16} />
          </button>
          <button title="删除" onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="metric-grid">
        <Metric label="组合总市值" value={formatMoney(observation?.totalMarketValue ?? 0)} />
        <Metric
          label="累计收益"
          value={formatMoney(observation?.profitAmount ?? 0)}
          subValue={formatPercent(observation?.profitRate ?? 0)}
          tone={(observation?.profitAmount ?? 0) >= 0 ? "positive" : "negative"}
        />
        <Metric
          label="组合偏离"
          value={observation ? `${observation.portfolioDriftPercent.toFixed(2)}%` : "0.00%"}
          status={observation?.rebalanceStatus}
          detail="组合偏离 = 调回目标所需买卖金额的一半 / 组合总市值"
        />
      </div>

      <div className="holding-table">
        <div className="row head">
          <SortHeader label="持仓" sortKey="holding" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortHeader label="目标" sortKey="target" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortHeader label="当前" sortKey="current" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortHeader label="偏离" sortKey="drift" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortHeader label="建议" sortKey="rebalance" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
        </div>
        {sortedHoldings.map((item) => (
          <div className="row" key={item.holding.id}>
            <span>
              <span className="holding-name-line">
                <StatusDot status={item.rebalanceStatus} detail={getStatusDetail(item)} />
                <strong>{item.holding.name}</strong>
              </span>
              <small>{item.holding.code ?? item.navDate ?? item.error}</small>
              {item.error ? <em>{item.error}</em> : null}
            </span>
            <span>{item.targetPercent.toFixed(2)}%</span>
            <span>{item.currentPercent.toFixed(2)}%</span>
            <span className={toneClass(item.driftPercentPoints)}>
              {signed(item.driftPercentPoints)}pp
              <small>{signed(item.relativeDriftPercent)}%</small>
            </span>
            <span className={toneClass(item.rebalanceAmount)}>
              {item.error ? "待重试" : `${item.rebalanceAmount >= 0 ? "买入 " : "卖出 "}${formatMoney(Math.abs(item.rebalanceAmount))}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

interface EditPanelProps {
  form: PortfolioConfig;
  targetSum: number;
  errors: string[];
  importText: string;
  setImportText: (text: string) => void;
  onChange: (form: PortfolioConfig) => void;
  onSave: () => void;
  onImport: () => void;
  onFileImport: (event: ChangeEvent<HTMLInputElement>) => void;
  loadingNameIds: Set<string>;
  onAddFund: () => void;
  onAddCash: () => void;
  onUpdateHolding: (id: string, patch: Partial<HoldingConfig>) => void;
  onCompleteFundName: (id: string) => void;
  onRemoveHolding: (id: string) => void;
}

const EditPanel = ({
  form,
  targetSum,
  errors,
  importText,
  setImportText,
  onChange,
  onSave,
  onImport,
  onFileImport,
  loadingNameIds,
  onAddFund,
  onAddCash,
  onUpdateHolding,
  onCompleteFundName,
  onRemoveHolding
}: EditPanelProps) => (
  <div className="panel">
    <div className="form-grid">
      <label>
        配置名称
        <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
      </label>
      <label>
        总金额
        <input
          type="number"
          min="0"
          value={form.totalAmount}
          onChange={(event) => onChange({ ...form, totalAmount: Number(event.target.value) })}
        />
      </label>
      <label>
        起始日期
        <input
          type="date"
          value={form.startDate}
          onChange={(event) => onChange({ ...form, startDate: event.target.value })}
        />
      </label>
    </div>

    <section className="threshold-box">
      <div className="section-head">
        <h3>再平衡阈值</h3>
      </div>
      <div className="threshold-grid">
        <label>
          pp 阈值
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={form.thresholds?.absolutePercentPoints ?? DEFAULT_THRESHOLDS.absolutePercentPoints}
            onChange={(event) =>
              onChange({
                ...form,
                thresholds: {
                  ...(form.thresholds ?? DEFAULT_THRESHOLDS),
                  absolutePercentPoints: Number(event.target.value)
                }
              })
            }
          />
        </label>
        <label>
          相对偏离阈值
          <input
            type="number"
            min="1"
            step="1"
            value={form.thresholds?.relativePercent ?? DEFAULT_THRESHOLDS.relativePercent}
            onChange={(event) =>
              onChange({
                ...form,
                thresholds: {
                  ...(form.thresholds ?? DEFAULT_THRESHOLDS),
                  relativePercent: Number(event.target.value)
                }
              })
            }
          />
        </label>
      </div>
    </section>

    <section className="import-box">
      <div className="section-head">
        <h3>导入基金</h3>
        <label className="file-button">
          <Upload size={15} />
          JSON 文件
          <input type="file" accept="application/json,.json" onChange={onFileImport} />
        </label>
      </div>
      <textarea
        value={importText}
        onChange={(event) => setImportText(event.target.value)}
        placeholder="粘贴 JSON 文本"
      />
      <button className="secondary" onClick={onImport} disabled={!importText.trim()}>
        提取基金代码
      </button>
    </section>

    <section>
      <div className="section-head">
        <h3>持仓目标</h3>
        <div className={`target-sum ${Math.abs(targetSum - 100) < 0.0001 ? "ok" : "warn"}`}>
          {targetSum.toFixed(2)}%
        </div>
      </div>

      <div className="holding-editor">
        {form.holdings.map((holding) => (
          <div className={`holding-edit-row ${holding.kind}`} key={holding.id}>
            <select
              value={holding.kind}
              onChange={(event) =>
                onUpdateHolding(holding.id, {
                  kind: event.target.value as HoldingConfig["kind"],
                  name: event.target.value === "cash" ? "现金" : holding.name
                })
              }
            >
              <option value="fund">基金</option>
              <option value="cash">现金</option>
            </select>
            {holding.kind === "fund" ? (
              <input
                value={holding.code ?? ""}
                placeholder="代码"
                onBlur={() => onCompleteFundName(holding.id)}
                onChange={(event) => {
                  const nextCode = event.target.value;
                  const previousCode = holding.code ?? "";
                  onUpdateHolding(holding.id, {
                    code: nextCode,
                    name:
                      !holding.name.trim() || holding.name.trim() === previousCode
                        ? nextCode
                        : holding.name
                  });
                }}
              />
            ) : null}
            <div className="name-field">
              <input
                value={holding.name}
                placeholder="名称"
                onChange={(event) => onUpdateHolding(holding.id, { name: event.target.value })}
              />
              {loadingNameIds.has(holding.id) ? <span>查询中</span> : null}
            </div>
            <input
              type="number"
              min="0"
              max="100"
              value={holding.targetPercent}
              onChange={(event) =>
                onUpdateHolding(holding.id, { targetPercent: Number(event.target.value) })
              }
            />
            <button title="删除持仓" onClick={() => onRemoveHolding(holding.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      <div className="inline-actions">
        <button onClick={onAddFund}>
          <Plus size={15} />
          基金
        </button>
        <button onClick={onAddCash}>
          <Plus size={15} />
          现金
        </button>
      </div>
    </section>

    {errors.length > 0 ? <div className="errors">{errors[0]}</div> : null}
    <button className="save-button" onClick={onSave} disabled={errors.length > 0}>
      <Check size={16} />
      保存配置
    </button>
  </div>
);

const Metric = ({
  label,
  value,
  subValue,
  tone,
  status,
  detail
}: {
  label: string;
  value: string;
  subValue?: string;
  tone?: "positive" | "negative";
  status?: PortfolioObservation["rebalanceStatus"];
  detail?: string;
}) => (
  <div className="metric">
    <span>
      {label}
      {status ? <StatusDot status={status} detail={detail ?? ""} /> : null}
    </span>
    <div className="metric-value">
      <strong className={tone}>{value}</strong>
      {subValue ? <em className={tone}>{subValue}</em> : null}
    </div>
  </div>
);

const StatusDot = ({
  status,
  detail
}: {
  status: PortfolioObservation["rebalanceStatus"];
  detail: string;
}) => (
  <span className={`status-dot ${status}`} tabIndex={0}>
    <span className="status-detail">{detail}</span>
  </span>
);

const SortHeader = ({
  label,
  sortKey,
  activeKey,
  direction,
  onSort
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) => (
  <button className="sort-header" onClick={() => onSort(sortKey)}>
    {label}
    <span>{activeKey === sortKey ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
  </button>
);

const getSortValue = (item: PortfolioObservation["holdings"][number], sortKey: SortKey) => {
  if (sortKey === "holding") {
    return `${item.holding.name}${item.holding.code ?? ""}`;
  }
  return "";
};

const getNumericSortValue = (item: PortfolioObservation["holdings"][number], sortKey: SortKey) => {
  if (sortKey === "target") {
    return item.targetPercent;
  }
  if (sortKey === "current") {
    return item.currentPercent;
  }
  if (sortKey === "drift") {
    return Math.abs(item.relativeDriftPercent);
  }
  if (sortKey === "rebalance") {
    return item.rebalanceAmount;
  }
  return 0;
};

const readError = (error: unknown) => (error instanceof Error ? error.message : "操作失败");
const formatMoney = (value: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value);
const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
const toneClass = (value: number) => (value > 0 ? "positive" : value < 0 ? "negative" : "neutral");

const getStatusDetail = (item: PortfolioObservation["holdings"][number]) => {
  if (item.rebalanceStatus === "error") {
    return item.error ?? "基金数据获取失败";
  }
  const statusLabel =
    item.rebalanceStatus === "rebalance"
      ? "建议再平衡"
      : item.rebalanceStatus === "watch"
        ? "观察"
        : "正常";
  return `${statusLabel}：偏离 ${signed(item.driftPercentPoints)}pp，相对偏离 ${signed(
    item.relativeDriftPercent
  )}%`;
};
