import { ChangeEvent, CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, Pencil, Plus, RefreshCw, Star, Trash2, Upload } from "lucide-react";
import {
  DEFAULT_THRESHOLDS,
  calculatePortfolioObservation,
  validatePortfolioConfig
} from "../domain/calculation";
import { parseFundImport } from "../domain/importers";
import type {
  AppState,
  BenchmarkReturn,
  FundSnapshot,
  HoldingConfig,
  PortfolioConfig,
  PortfolioObservation
} from "../domain/types";
import {
  BENCHMARK_CANDIDATES,
  DEFAULT_BENCHMARK_CODES,
  MAX_BENCHMARK_SELECTION,
  normalizeBenchmarkCodes
} from "../services/benchmarkApi";
import { loadBenchmarkReturns } from "../services/benchmarkClient";
import { getCachedSnapshot, loadQuotesForConfig } from "../services/fundClient";
import { createInitialState, loadState, saveState } from "../services/storage";

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const createEmptyConfig = (): PortfolioConfig => ({
  id: uid(),
  name: "",
  totalAmount: 100000,
  startDate: today(),
  benchmarkCodes: DEFAULT_BENCHMARK_CODES,
  thresholds: DEFAULT_THRESHOLDS,
  holdings: [],
  createdAt: Date.now(),
  updatedAt: Date.now()
});

const createDuplicateName = (name: string, configs: PortfolioConfig[]) => {
  const baseName = name.trim() || "未命名配置";
  const firstName = `${baseName} 副本`;
  const existingNames = new Set(configs.map((config) => config.name));

  if (!existingNames.has(firstName)) {
    return firstName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const nextName = `${firstName} ${index}`;
    if (!existingNames.has(nextName)) {
      return nextName;
    }
  }

  return `${firstName} ${Date.now()}`;
};

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
type ObserveView = "overview" | "drift" | "detail";
type RefreshFeedback = "idle" | "refreshing" | "success";
type ButtonFeedback = "idle" | "busy" | "success" | "error";

export const App = () => {
  const [state, setState] = useState<AppState>(createInitialState);
  const [form, setForm] = useState<PortfolioConfig>(createEmptyConfig);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<"observe" | "edit">("edit");
  const [observation, setObservation] = useState<PortfolioObservation | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkReturn[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [loadingNameIds, setLoadingNameIds] = useState<Set<string>>(new Set());
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>("idle");
  const [refreshError, setRefreshError] = useState("");
  const [saveFeedback, setSaveFeedback] = useState<ButtonFeedback>("idle");
  const [saveError, setSaveError] = useState("");
  const [importFeedback, setImportFeedback] = useState<ButtonFeedback>("idle");
  const [importError, setImportError] = useState("");
  const [primaryFeedback, setPrimaryFeedback] = useState<ButtonFeedback>("idle");
  const [duplicateFeedback, setDuplicateFeedback] = useState<ButtonFeedback>("idle");
  const [deleteFeedback, setDeleteFeedback] = useState<ButtonFeedback>("idle");
  const [nameSuccessIds, setNameSuccessIds] = useState<Set<string>>(new Set());
  const [nameErrorIds, setNameErrorIds] = useState<Set<string>>(new Set());
  const [importText, setImportText] = useState("");
  const refreshFeedbackTimer = useRef<number | null>(null);
  const feedbackTimers = useRef<number[]>([]);

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
    saveState(state).catch((error) => setSaveError(readError(error)));
  }, [loaded, state]);

  useEffect(() => {
    if (!selectedConfig) {
      setObservation(null);
      setBenchmarks([]);
      return;
    }
    setForm(structuredClone(selectedConfig));
    void refreshObservation(selectedConfig, false);
  }, [selectedConfig?.id]);

  useEffect(() => {
    return () => {
      if (refreshFeedbackTimer.current !== null) {
        window.clearTimeout(refreshFeedbackTimer.current);
      }
      feedbackTimers.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const patchState = (updater: (current: AppState) => AppState) => {
    setState((current) => updater(current));
  };

  const resetTimedFeedback = (setter: (status: ButtonFeedback) => void, delay = 1200) => {
    const timer = window.setTimeout(() => {
      setter("idle");
      feedbackTimers.current = feedbackTimers.current.filter((item) => item !== timer);
    }, delay);
    feedbackTimers.current.push(timer);
  };

  const markNameStatus = (ids: string[], status: "success" | "error") => {
    const setter = status === "success" ? setNameSuccessIds : setNameErrorIds;
    setter((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      return next;
    });
    const timer = window.setTimeout(() => {
      setter((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      feedbackTimers.current = feedbackTimers.current.filter((item) => item !== timer);
    }, 1400);
    feedbackTimers.current.push(timer);
  };

  const refreshObservation = async (config = selectedConfig, forceRefresh = true) => {
    if (!config) {
      return;
    }

    setLoadingQuotes(true);
    if (refreshFeedbackTimer.current !== null) {
      window.clearTimeout(refreshFeedbackTimer.current);
      refreshFeedbackTimer.current = null;
    }
    if (forceRefresh) {
      setRefreshFeedback("refreshing");
      setRefreshError("");
    }
    const [quoteResult, benchmarkResult] = await Promise.allSettled([
      loadQuotesForConfig(config, state, forceRefresh),
      loadBenchmarkReturns(config.startDate, normalizeBenchmarkCodes(config.benchmarkCodes))
    ]);

    if (quoteResult.status === "rejected") {
      setLoadingQuotes(false);
      if (forceRefresh) {
        setRefreshFeedback("idle");
      }
      setRefreshError(readError(quoteResult.reason));
      return;
    }

    const result = quoteResult.value;
    const nextObservation = calculatePortfolioObservation(config, result.quotes);

    setObservation(nextObservation);
    setBenchmarks(benchmarkResult.status === "fulfilled" ? benchmarkResult.value : []);
    patchState((current) => ({
      ...current,
      fundCache: { ...current.fundCache, ...result.fundCachePatch },
      historicalCache: { ...current.historicalCache, ...result.historicalCachePatch }
    }));
    setLoadingQuotes(false);
    if (forceRefresh) {
      setRefreshFeedback("success");
      refreshFeedbackTimer.current = window.setTimeout(() => {
        setRefreshFeedback("idle");
        refreshFeedbackTimer.current = null;
      }, 1200);
    }
  };

  const saveCurrentConfig = async () => {
    setSaveFeedback("busy");
    setSaveError("");
    const errors = validatePortfolioConfig(form);
    if (errors.length > 0) {
      setSaveFeedback("error");
      setSaveError(errors[0]);
      resetTimedFeedback(setSaveFeedback);
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
      benchmarkCodes: normalizeBenchmarkCodes(form.benchmarkCodes),
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
    setSaveFeedback("success");
    resetTimedFeedback(setSaveFeedback);
    void refreshObservation(normalized, true);
  };

  const selectConfig = (config: PortfolioConfig) => {
    patchState((current) => ({ ...current, selectedConfigId: config.id }));
    setActiveTab("observe");
    setRefreshError("");
  };

  const deleteConfig = (id: string) => {
    setDeleteFeedback("busy");
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
    setDeleteFeedback("success");
    resetTimedFeedback(setDeleteFeedback);
  };

  const duplicateConfig = (config: PortfolioConfig) => {
    const now = Date.now();
    const duplicate: PortfolioConfig = {
      ...structuredClone(config),
      id: uid(),
      name: createDuplicateName(config.name, state.configs),
      holdings: config.holdings.map((holding) => ({
        ...holding,
        id: uid()
      })),
      createdAt: now,
      updatedAt: now
    };

    patchState((current) => {
      const configIndex = current.configs.findIndex((item) => item.id === config.id);
      const insertIndex = configIndex >= 0 ? configIndex + 1 : current.configs.length;
      const configs = [
        ...current.configs.slice(0, insertIndex),
        duplicate,
        ...current.configs.slice(insertIndex)
      ];

      return {
        ...current,
        configs,
        selectedConfigId: duplicate.id
      };
    });
    setForm(structuredClone(duplicate));
    setActiveTab("edit");
    setObservation(null);
    setDuplicateFeedback("success");
    resetTimedFeedback(setDuplicateFeedback);
  };

  const setPrimary = (id: string) => {
    patchState((current) => ({ ...current, primaryConfigId: id, selectedConfigId: id }));
    setPrimaryFeedback("success");
    resetTimedFeedback(setPrimaryFeedback);
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
    setNameSuccessIds((current) => {
      const next = new Set(current);
      fundHoldings.forEach((holding) => next.delete(holding.id));
      return next;
    });
    setNameErrorIds((current) => {
      const next = new Set(current);
      fundHoldings.forEach((holding) => next.delete(holding.id));
      return next;
    });

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
      markNameStatus(
        failures.map((item) => item.holdingId),
        "error"
      );
      return;
    }
    markNameStatus(
      snapshots.map((item) => item.holdingId),
      "success"
    );
  };

  const completeFundName = async (holdingId: string) => {
    const holding = form.holdings.find((item) => item.id === holdingId);
    if (!holding || holding.kind !== "fund" || !holding.code?.trim()) {
      return;
    }
    await completeFundNames([holding]);
  };

  const importCodes = async (text: string) => {
    setImportFeedback("busy");
    setImportError("");
    try {
      const result = parseFundImport(text);
      const existingCodes = new Set(
        form.holdings.map((holding) => holding.code).filter((code): code is string => Boolean(code))
      );
      const newHoldings = result.codes
        .filter((code) => !existingCodes.has(code))
        .map((code) => createFundHolding(code));
      setForm((current) => ({ ...current, holdings: [...current.holdings, ...newHoldings] }));
      setImportFeedback("success");
      resetTimedFeedback(setImportFeedback);
      setImportText("");
      void completeFundNames(newHoldings);
    } catch (error) {
      setImportFeedback("error");
      setImportError(readError(error));
      resetTimedFeedback(setImportFeedback);
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
        {activeTab === "observe" ? (
          <ObservePanel
            config={selectedConfig}
            observation={observation}
            benchmarks={benchmarks}
            loading={loadingQuotes}
            refreshFeedback={refreshFeedback}
            refreshError={refreshError}
            isPrimary={selectedConfig?.id === state.primaryConfigId}
            primaryFeedback={primaryFeedback}
            duplicateFeedback={duplicateFeedback}
            deleteFeedback={deleteFeedback}
            onRefresh={() => void refreshObservation(selectedConfig, true)}
            onEdit={() => setActiveTab("edit")}
            onPrimary={() => selectedConfig && setPrimary(selectedConfig.id)}
            onDuplicate={() => selectedConfig && duplicateConfig(selectedConfig)}
            onDelete={() => selectedConfig && deleteConfig(selectedConfig.id)}
          />
        ) : (
          <EditPanel
            form={form}
            targetSum={targetSum}
            errors={validationErrors}
            saveFeedback={saveFeedback}
            saveError={saveError}
            importFeedback={importFeedback}
            importError={importError}
            importText={importText}
            setImportText={setImportText}
            onChange={setForm}
            onSave={() => void saveCurrentConfig()}
            onImport={() => void importCodes(importText)}
            onFileImport={importFile}
            loadingNameIds={loadingNameIds}
            nameSuccessIds={nameSuccessIds}
            nameErrorIds={nameErrorIds}
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
  benchmarks: BenchmarkReturn[];
  loading: boolean;
  refreshFeedback: RefreshFeedback;
  refreshError: string;
  isPrimary: boolean;
  primaryFeedback: ButtonFeedback;
  duplicateFeedback: ButtonFeedback;
  deleteFeedback: ButtonFeedback;
  onRefresh: () => void;
  onEdit: () => void;
  onPrimary: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const ObservePanel = ({
  config,
  observation,
  benchmarks,
  loading,
  refreshFeedback,
  refreshError,
  isPrimary,
  primaryFeedback,
  duplicateFeedback,
  deleteFeedback,
  onRefresh,
  onEdit,
  onPrimary,
  onDuplicate,
  onDelete
}: ObservePanelProps) => {
  const [sortKey, setSortKey] = useState<SortKey>("target");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [view, setView] = useState<ObserveView>("overview");
  const holdings = observation?.holdings ?? [];
  const sortedHoldings = useMemo(() => {
    const nextHoldings = [...holdings];
    return nextHoldings.sort((left, right) => {
      const delta = getSortValue(left, sortKey).localeCompare(getSortValue(right, sortKey), "zh-CN", {
        numeric: true
      });
      const numericDelta = getNumericSortValue(left, sortKey) - getNumericSortValue(right, sortKey);
      const result = sortKey === "holding" ? delta : numericDelta;
      return sortDirection === "asc" ? result : -result;
    });
  }, [holdings, sortDirection, sortKey]);
  const actionItems = useMemo(
    () =>
      holdings
        .filter((item) => !item.error && Math.abs(item.rebalanceAmount) > 0.005)
        .sort((left, right) => Math.abs(right.rebalanceAmount) - Math.abs(left.rebalanceAmount)),
    [holdings]
  );
  const driftItems = useMemo(
    () =>
      [...holdings]
        .filter((item) => !item.error)
        .sort((left, right) => Math.abs(right.driftPercentPoints) - Math.abs(left.driftPercentPoints)),
    [holdings]
  );
  const maxAbsDrift = Math.max(5, ...driftItems.map((item) => Math.abs(item.driftPercentPoints)));
  const refreshIcon =
    refreshFeedback === "success" && !loading ? (
      <Check size={16} className="refresh-success-icon" />
    ) : (
      <RefreshCw size={16} className={loading || refreshFeedback === "refreshing" ? "spin" : ""} />
    );
  const primaryIcon =
    primaryFeedback === "success" ? (
      <Check size={16} className="refresh-success-icon" />
    ) : (
      <Star size={16} fill={isPrimary ? "currentColor" : "none"} />
    );
  const duplicateIcon =
    duplicateFeedback === "success" ? <Check size={16} className="refresh-success-icon" /> : <Copy size={16} />;
  const deleteIcon =
    deleteFeedback === "busy" ? (
      <LoaderCircle size={16} className="spin" />
    ) : deleteFeedback === "success" ? (
      <Check size={16} className="refresh-success-icon" />
    ) : (
      <Trash2 size={16} />
    );

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
    <div className={`panel observe-panel observe-panel-${view}`}>
      <div className="panel-title">
        <div>
          <h2>{config.name}</h2>
          <p>{config.startDate} 起 · {formatMoney(config.totalAmount)}</p>
        </div>
        <div className="icon-actions">
          <button
            title={refreshFeedback === "success" ? "刷新成功" : "刷新净值"}
            aria-label={refreshFeedback === "success" ? "刷新成功" : "刷新净值"}
            className={refreshFeedback === "success" && !loading ? "action-success" : ""}
            onClick={onRefresh}
            disabled={loading}
          >
            {refreshIcon}
          </button>
          <button
            title={primaryFeedback === "success" ? "已设为主配置" : "设为主配置"}
            onClick={onPrimary}
            className={`${isPrimary ? "selected" : ""} ${primaryFeedback === "success" ? "action-success" : ""}`}
          >
            {primaryIcon}
          </button>
          <button title="编辑" onClick={onEdit}>
            <Pencil size={16} />
          </button>
          <button
            title={duplicateFeedback === "success" ? "已复制" : "复制配置"}
            onClick={onDuplicate}
            className={duplicateFeedback === "success" ? "action-success" : ""}
          >
            {duplicateIcon}
          </button>
          <button
            title={deleteFeedback === "success" ? "已删除" : "删除"}
            onClick={onDelete}
            className={deleteFeedback === "success" ? "action-success" : ""}
            disabled={deleteFeedback === "busy"}
          >
            {deleteIcon}
          </button>
        </div>
      </div>
      {refreshError ? <div className="panel-feedback error">{refreshError}</div> : null}

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
          gaugeValue={observation?.portfolioDriftPercent ?? 0}
          gaugeStatus={observation?.rebalanceStatus ?? "ok"}
        />
      </div>

      <BenchmarkStrip benchmarks={benchmarks} portfolioRate={observation?.profitRate ?? 0} loading={loading} />

      <div className="observe-switch" role="tablist" aria-label="观测视图">
        <button className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
          概览
        </button>
        <button className={view === "drift" ? "active" : ""} onClick={() => setView("drift")}>
          偏离
        </button>
        <button className={view === "detail" ? "active" : ""} onClick={() => setView("detail")}>
          明细
        </button>
      </div>

      <div className="observe-content">
        {view === "overview" ? <OverviewPanel holdings={holdings} /> : null}

        {view === "drift" ? (
          <div className="drift-view">
            <ActionSummary
              items={actionItems}
              targetAmount={config.totalAmount}
              totalMarketValue={observation?.totalMarketValue ?? config.totalAmount}
            />
            <DriftRanking items={driftItems} maxAbsDrift={maxAbsDrift} />
          </div>
        ) : null}

        {view === "detail" ? (
          <HoldingDetailTable
            sortedHoldings={sortedHoldings}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={changeSort}
          />
        ) : null}
      </div>
    </div>
  );
};

interface EditPanelProps {
  form: PortfolioConfig;
  targetSum: number;
  errors: string[];
  saveFeedback: ButtonFeedback;
  saveError: string;
  importFeedback: ButtonFeedback;
  importError: string;
  importText: string;
  setImportText: (text: string) => void;
  onChange: (form: PortfolioConfig) => void;
  onSave: () => void;
  onImport: () => void;
  onFileImport: (event: ChangeEvent<HTMLInputElement>) => void;
  loadingNameIds: Set<string>;
  nameSuccessIds: Set<string>;
  nameErrorIds: Set<string>;
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
  saveFeedback,
  saveError,
  importFeedback,
  importError,
  importText,
  setImportText,
  onChange,
  onSave,
  onImport,
  onFileImport,
  loadingNameIds,
  nameSuccessIds,
  nameErrorIds,
  onAddFund,
  onAddCash,
  onUpdateHolding,
  onCompleteFundName,
  onRemoveHolding
}: EditPanelProps) => {
  const importButtonIcon =
    importFeedback === "busy" ? (
      <LoaderCircle size={15} className="spin" />
    ) : importFeedback === "success" ? (
      <Check size={15} className="refresh-success-icon" />
    ) : (
      <Upload size={15} />
    );
  const saveButtonIcon =
    saveFeedback === "busy" ? (
      <LoaderCircle size={16} className="spin" />
    ) : saveFeedback === "success" ? (
      <Check size={16} className="refresh-success-icon" />
    ) : (
      <Check size={16} />
    );

  return (
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

    <section className="benchmark-config-box">
      <div className="section-head">
        <h3>同期基准</h3>
        <span>{normalizeBenchmarkCodes(form.benchmarkCodes).length}/{MAX_BENCHMARK_SELECTION}</span>
      </div>
      <div className="benchmark-options">
        {BENCHMARK_CANDIDATES.map((benchmark) => {
          const selectedCodes = normalizeBenchmarkCodes(form.benchmarkCodes);
          const selectedIndex = selectedCodes.indexOf(benchmark.code);
          const selected = selectedIndex >= 0;
          const disabled = !selected && selectedCodes.length >= MAX_BENCHMARK_SELECTION;
          return (
            <label className={selected ? "selected" : ""} key={benchmark.code}>
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  const nextCodes = selected
                    ? selectedCodes.filter((code) => code !== benchmark.code)
                    : [...selectedCodes, benchmark.code];
                  onChange({ ...form, benchmarkCodes: normalizeBenchmarkCodes(nextCodes) });
                }}
              />
              {selected ? <em>{selectedIndex + 1}</em> : null}
              <span>{benchmark.name}</span>
            </label>
          );
        })}
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
        {importButtonIcon}
        {importFeedback === "busy" ? "提取中" : importFeedback === "success" ? "已提取" : "提取基金代码"}
      </button>
      {importError ? <div className="panel-feedback error">{importError}</div> : null}
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
              {loadingNameIds.has(holding.id) ? <span><LoaderCircle size={12} className="spin" /></span> : null}
              {nameSuccessIds.has(holding.id) ? <span className="name-success"><Check size={12} /></span> : null}
              {nameErrorIds.has(holding.id) ? <span className="name-error">!</span> : null}
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

    {errors.length > 0 || saveError ? <div className="errors">{saveError || errors[0]}</div> : null}
    <button
      className={`save-button ${saveFeedback === "success" ? "action-success" : ""}`}
      onClick={onSave}
      disabled={errors.length > 0 || saveFeedback === "busy"}
    >
      {saveButtonIcon}
      {saveFeedback === "busy" ? "保存中" : saveFeedback === "success" ? "已保存" : "保存配置"}
    </button>
  </div>
  );
};

const Metric = ({
  label,
  value,
  subValue,
  tone,
  status,
  detail,
  gaugeValue,
  gaugeStatus
}: {
  label: string;
  value: string;
  subValue?: string;
  tone?: "positive" | "negative";
  status?: PortfolioObservation["rebalanceStatus"];
  detail?: string;
  gaugeValue?: number;
  gaugeStatus?: PortfolioObservation["rebalanceStatus"];
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
    {gaugeValue !== undefined ? <InlineDriftGauge value={gaugeValue} status={gaugeStatus ?? "ok"} /> : null}
  </div>
);

const InlineDriftGauge = ({
  value,
  status
}: {
  value: number;
  status: PortfolioObservation["rebalanceStatus"];
}) => {
  const style = { "--value": `${Math.min(100, (value / 7.5) * 100)}%` } as CSSProperties;
  return <i className={`inline-drift-gauge ${status}`} style={style} />;
};

const BenchmarkStrip = ({
  benchmarks,
  portfolioRate,
  loading
}: {
  benchmarks: BenchmarkReturn[];
  portfolioRate: number;
  loading: boolean;
}) => (
  <section className="benchmark-strip">
    <span>同期基准</span>
    <div>
      {benchmarks.length > 0 ? (
        benchmarks.map((item) => {
          const diff = portfolioRate - item.returnRate;
          return (
            <article key={item.code} title={`${item.startDate} 至 ${item.endDate}`}>
              <strong>{item.name}</strong>
              <em className={toneClass(item.returnRate)}>{formatPercent(item.returnRate)}</em>
              <small className={toneClass(diff)}>组合 {diff >= 0 ? "领先" : "落后"} {formatPercent(Math.abs(diff))}</small>
            </article>
          );
        })
      ) : (
        <p>{loading ? "基准加载中" : "暂无基准数据"}</p>
      )}
    </div>
  </section>
);

const OverviewPanel = ({ holdings }: { holdings: PortfolioObservation["holdings"] }) => {
  const validHoldings = holdings.filter((item) => !item.error);
  const statusCounts = {
    ok: validHoldings.filter((item) => item.rebalanceStatus === "ok").length,
    watch: validHoldings.filter((item) => item.rebalanceStatus === "watch").length,
    rebalance: validHoldings.filter((item) => item.rebalanceStatus === "rebalance").length,
    error: holdings.filter((item) => item.rebalanceStatus === "error").length
  };
  const overweight = [...validHoldings]
    .filter((item) => item.driftPercentPoints > 0)
    .sort((left, right) => right.driftPercentPoints - left.driftPercentPoints)[0];
  const underweight = [...validHoldings]
    .filter((item) => item.driftPercentPoints < 0)
    .sort((left, right) => left.driftPercentPoints - right.driftPercentPoints)[0];
  const attentionItems = [...holdings]
    .filter((item) => item.rebalanceStatus !== "ok")
    .sort((left, right) => statusPriority(right.rebalanceStatus) - statusPriority(left.rebalanceStatus));
  const diagnosis = getOverviewDiagnosis(statusCounts);

  return (
    <div className="overview-grid">
      <AllocationCompare holdings={holdings} />
      <section className="visual-card diagnosis-card">
        <div className="section-head">
          <h3>组合诊断</h3>
        </div>
        <StatusMix counts={statusCounts} />
        <AttentionList items={attentionItems} />
        <div className="diagnosis-list">
          <DiagnosisItem label="最大超配" item={overweight} tone="positive" fallback="暂无明显超配" />
          <DiagnosisItem label="最大低配" item={underweight} tone="negative" fallback="暂无明显低配" />
        </div>
        <p className="diagnosis-copy">{diagnosis}</p>
      </section>
    </div>
  );
};

const AllocationCompare = ({ holdings }: { holdings: PortfolioObservation["holdings"] }) => {
  const sortedHoldings = [...holdings].sort((left, right) => right.targetPercent - left.targetPercent);

  return (
    <section className="visual-card allocation-card">
      <div className="section-head">
        <h3>目标 / 当前占比</h3>
      </div>
      <div className="allocation-bars">
        <AllocationStack holdings={sortedHoldings} mode="target" />
        <AllocationStack holdings={sortedHoldings} mode="current" />
      </div>
      <div className="allocation-legend">
        {sortedHoldings.map((item, index) => (
          <span key={item.holding.id}>
            <i style={{ background: chartColor(index) }} />
            {item.holding.name}
          </span>
        ))}
      </div>
    </section>
  );
};

const AllocationStack = ({
  holdings,
  mode
}: {
  holdings: PortfolioObservation["holdings"];
  mode: "target" | "current";
}) => (
  <div className="allocation-stack-row">
    <span>{mode === "target" ? "目标" : "当前"}</span>
    <div className="allocation-stack">
      {holdings.map((item, index) => {
        const value = mode === "target" ? item.targetPercent : item.currentPercent;
        return (
          <i
            key={item.holding.id}
            tabIndex={0}
            style={{ width: `${Math.max(value, value > 0 ? 1.5 : 0)}%`, background: chartColor(index) }}
          >
            <span>
              <strong>{item.holding.name}</strong>
              <em>{mode === "target" ? "目标" : "当前"} {value.toFixed(2)}%</em>
              {mode === "current" ? <small>{getAllocationTooltipDetail(item)}</small> : null}
            </span>
          </i>
        );
      })}
    </div>
  </div>
);

const StatusMix = ({
  counts
}: {
  counts: Record<PortfolioObservation["rebalanceStatus"], number>;
}) => {
  const total = Math.max(1, counts.ok + counts.watch + counts.rebalance + counts.error);

  return (
    <div className="status-mix">
      <div className="status-mix-bar">
        <i className="ok" style={{ width: `${(counts.ok / total) * 100}%` }} />
        <i className="watch" style={{ width: `${(counts.watch / total) * 100}%` }} />
        <i className="rebalance" style={{ width: `${(counts.rebalance / total) * 100}%` }} />
        <i className="error" style={{ width: `${(counts.error / total) * 100}%` }} />
      </div>
      <div className="status-pills">
        <span>正常 {counts.ok}</span>
        <span>观察 {counts.watch}</span>
        <span>再平衡 {counts.rebalance}</span>
        <span>异常 {counts.error}</span>
      </div>
    </div>
  );
};

const AttentionList = ({ items }: { items: PortfolioObservation["holdings"] }) => {
  const visibleItems = items.slice(0, 3);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <div className="attention-list">
      <span>需关注</span>
      {visibleItems.length === 0 ? (
        <strong>暂无</strong>
      ) : (
        <div>
          {visibleItems.map((item) => (
            <em className={item.rebalanceStatus} key={item.holding.id} title={getStatusDetail(item)}>
              {item.holding.name}
            </em>
          ))}
          {hiddenCount > 0 ? <em className="more">+{hiddenCount}</em> : null}
        </div>
      )}
    </div>
  );
};

const DiagnosisItem = ({
  label,
  item,
  tone,
  fallback
}: {
  label: string;
  item?: PortfolioObservation["holdings"][number];
  tone: "positive" | "negative";
  fallback: string;
}) => (
  <div className="diagnosis-item">
    <span>{label}</span>
    <strong>{item?.holding.name ?? fallback}</strong>
    {item ? <em className={tone}>{tone === "positive" ? "超配" : "低配"}</em> : null}
  </div>
);

const ActionSummary = ({
  items,
  targetAmount,
  totalMarketValue
}: {
  items: PortfolioObservation["holdings"];
  targetAmount: number;
  totalMarketValue: number;
}) => {
  const buyItems = items.filter((item) => item.rebalanceAmount > 0);
  const sellItems = items.filter((item) => item.rebalanceAmount < 0);
  const buyTotal = buyItems.reduce((sum, item) => sum + item.rebalanceAmount, 0);
  const sellTotal = sellItems.reduce((sum, item) => sum + Math.abs(item.rebalanceAmount), 0);
  const internalTurnover = Math.min(buyTotal, sellTotal);
  const fundingGap = normalizeMoneyValue(targetAmount - totalMarketValue);
  const turnoverRate = totalMarketValue > 0 ? internalTurnover / totalMarketValue : 0;
  const fundingGapRate = targetAmount > 0 ? Math.abs(fundingGap) / targetAmount : 0;
  const leadBuy = buyItems[0];
  const leadSell = sellItems[0];
  const fundingLabel = fundingGap >= 0 ? "另需投入" : "超出目标";
  const fundingDetail =
    fundingGap >= 0
      ? "配置总金额减去当前组合总市值，表示回到目标投入规模还需要追加的外部资金。"
      : "当前组合总市值高于配置总金额，表示超出目标投入规模的金额。";
  const fundingTone = fundingGap >= 0 ? "positive" : "negative";

  return (
    <section className="visual-card action-card">
      <div className="section-head">
        <h3>资金搬移摘要</h3>
      </div>
      <div className="action-summary-grid">
        <div className="primary">
          <InfoHint
            label="内部换手"
            detail="正常情况下，卖出释放、买入补足和可对冲换手是同一个数：不改变组合总资金规模时，需要从超配持仓搬到低配持仓的金额。"
          />
          <strong>{formatMoney(internalTurnover)}</strong>
          <small>占组合 {formatPercent(turnoverRate)}</small>
        </div>
        <div className={fundingTone}>
          <InfoHint label={fundingLabel} detail={fundingDetail} />
          <strong>{formatMoney(Math.abs(fundingGap))}</strong>
          <small>占目标 {formatPercent(fundingGapRate)}</small>
        </div>
      </div>
      <div className="action-focus">
        <ActionFocusItem label="最大卖出" item={leadSell} tone="negative" />
        <ActionFocusItem label="最大买入" item={leadBuy} tone="positive" />
      </div>
      <div className="action-stats">
        <ActionStat
          label="换手率"
          value={formatPercent(turnoverRate)}
          detail="内部换手金额 / 当前组合总市值，用来衡量这次再平衡动作相对组合规模有多大。"
        />
        <ActionStat
          label="卖出项"
          value={`${sellItems.length} 只`}
          detail="建议卖出的持仓数量，用来判断超配来源是否集中。"
        />
        <ActionStat
          label="买入项"
          value={`${buyItems.length} 只`}
          detail="建议买入的持仓数量，用来判断低配补足是否分散。"
        />
      </div>
    </section>
  );
};

const InfoHint = ({ label, detail }: { label: string; detail: string }) => (
  <span className="info-hint" tabIndex={0}>
    <span>{label}</span>
    <span className="info-detail">{detail}</span>
  </span>
);

const ActionStat = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="action-stat">
    <InfoHint label={label} detail={detail} />
    <strong>{value}</strong>
  </div>
);

const ActionFocusItem = ({
  label,
  item,
  tone
}: {
  label: string;
  item?: PortfolioObservation["holdings"][number];
  tone: "positive" | "negative";
}) => (
  <div className="action-focus-item">
    <span>{label}</span>
    {item ? (
      <>
        <em className={tone}>{formatMoney(Math.abs(item.rebalanceAmount))}</em>
        <strong>{item.holding.name}</strong>
      </>
    ) : (
      <strong>暂无</strong>
    )}
  </div>
);

const DriftRanking = ({
  items,
  maxAbsDrift
}: {
  items: PortfolioObservation["holdings"];
  maxAbsDrift: number;
}) => (
  <section className="visual-card drift-ranking">
    <div className="section-head">
      <h3>持仓偏离排行</h3>
    </div>
    <div className="drift-list">
      {items.length === 0 ? (
        <div className="empty-visual">暂无可展示持仓</div>
      ) : (
        items.slice(0, 8).map((item) => {
          const width = Math.min(50, (Math.abs(item.driftPercentPoints) / maxAbsDrift) * 50);
          const sideClass = item.driftPercentPoints >= 0 ? "over" : "under";
          return (
            <div className="drift-row" key={item.holding.id} tabIndex={0}>
              <div className="drift-copy">
                <span className="drift-name">
                  <StatusDot status={item.rebalanceStatus} detail={getStatusDetail(item)} />
                  {item.holding.name}
                </span>
              </div>
              <div className="drift-axis">
                <i className={`drift-bar ${sideClass}`} style={{ width: `${width}%` }} />
              </div>
              <span className="drift-detail">{getDriftRankingDetail(item)}</span>
            </div>
          );
        })
      )}
    </div>
  </section>
);

const HoldingDetailTable = ({
  sortedHoldings,
  sortKey,
  sortDirection,
  onSort
}: {
  sortedHoldings: PortfolioObservation["holdings"];
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
}) => (
  <div className="holding-table">
    <div className="row head">
      <SortHeader label="持仓" sortKey="holding" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
      <SortHeader label="目标" sortKey="target" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
      <SortHeader label="当前" sortKey="current" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
      <SortHeader label="偏离" sortKey="drift" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
      <SortHeader label="建议" sortKey="rebalance" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
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
          {item.error
            ? "待重试"
            : `${item.rebalanceAmount >= 0 ? "买入 " : "卖出 "}${formatMoney(Math.abs(item.rebalanceAmount))}`}
        </span>
      </div>
    ))}
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
const normalizeMoneyValue = (value: number) => (Math.abs(value) < 0.005 ? 0 : value);
const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
const toneClass = (value: number) => (value > 0 ? "positive" : value < 0 ? "negative" : "neutral");
const getOverviewDiagnosis = (counts: Record<PortfolioObservation["rebalanceStatus"], number>) => {
  if (counts.error > 0) {
    return "有持仓数据异常，先刷新或检查代码后再判断组合状态。";
  }
  if (counts.rebalance > 0) {
    return "组合已有明确偏离来源，建议进入偏离页查看调仓方向。";
  }
  if (counts.watch > 0) {
    return "组合整体仍可控，但已有持仓进入观察区间。";
  }
  return "组合结构贴近目标，暂时不需要特别动作。";
};
const getAllocationTooltipDetail = (item: PortfolioObservation["holdings"][number]) => {
  if (item.error) {
    return item.error;
  }
  if (Math.abs(item.driftPercentPoints) < 0.005) {
    return "贴近目标";
  }
  return `${item.driftPercentPoints > 0 ? "高于目标" : "低于目标"} ${Math.abs(item.driftPercentPoints).toFixed(2)}pp`;
};
const statusPriority = (status: PortfolioObservation["rebalanceStatus"]) =>
  status === "error" ? 3 : status === "rebalance" ? 2 : status === "watch" ? 1 : 0;
const chartColor = (index: number) =>
  ["#365f91", "#c9892b", "#6f8f52", "#9b4d55", "#4f7f7b", "#8b6bb1", "#b75f35", "#6f6a61"][index % 8];

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

const getDriftRankingDetail = (item: PortfolioObservation["holdings"][number]) => {
  if (item.error) {
    return item.error;
  }
  const driftLabel = item.driftPercentPoints >= 0 ? "超配" : "低配";
  const actionLabel = item.rebalanceAmount >= 0 ? "建议买入" : "建议卖出";
  return `${item.holding.name}：${driftLabel} ${Math.abs(item.driftPercentPoints).toFixed(2)}pp，${actionLabel} ${formatMoney(Math.abs(item.rebalanceAmount))}`;
};
