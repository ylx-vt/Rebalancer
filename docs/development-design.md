# Rebalancer 开发设计文档

本文沉淀 `1.0.0` 版本的实现设计、关键模块边界，以及历史净值获取异常的排查过程和解决方案。

## 1. 产品与技术边界

Rebalancer 是一个 Chrome 插件，核心交互在 Popup 内闭环完成。

技术栈：

- Manifest V3
- TypeScript
- React
- Vite
- Chrome Storage 本地持久化

当前版本聚焦四件事：

- 基金配置录入
- 再平衡观测与可视化诊断
- 多配置切换
- JSON 导入

不包含交易执行、复杂分析、提醒系统和外部页面跳转。

## 2. 目录结构

```text
src/
  background.ts              # MV3 service worker，请求代理入口
  domain/
    calculation.ts           # 再平衡计算与配置校验
    importers.ts             # JSON 导入解析器注册机制
    types.ts                 # 业务类型定义
  services/
    fundApi.ts               # 基金实时净值、历史净值请求与解析
    fundClient.ts            # 缓存、批量 quote 加载、失败隔离
    logger.ts                # 统一日志封装
    storage.ts               # Chrome storage/localStorage 状态读写
  ui/
    App.tsx                  # Popup 主界面
    styles.css               # Popup 样式
public/
  manifest.json              # Chrome 插件声明与权限
```

## 3. 模块设计

### 3.1 视图层

`src/ui/App.tsx` 负责 Popup 内的完整交互：

- 配置列表展示与切换
- 新建、保存、删除配置
- 设置主配置
- JSON 文本导入、JSON 文件导入
- 基金/现金持仓编辑
- 调用观测刷新并展示结果
- 概览、偏离、明细三类观测视图切换

视图层不直接实现净值接口解析，也不直接写计算公式。

观测页的三个视图：

- 概览：展示目标/当前占比对比、状态分布、需关注持仓和组合诊断。
- 偏离：展示卖出释放、买入补足、可对冲换手、最大买卖项和持仓偏离排行。
- 明细：展示每只持仓的目标占比、当前占比、偏离和建议调仓金额，并支持排序。

### 3.2 计算层

`src/domain/calculation.ts` 负责纯业务计算：

- 初始份额 = 初始分配金额 / 起始净值
- 当前市值 = 当前净值 * 初始份额
- 当前占比 = 持仓当前市值 / 组合总市值
- 偏离 = 当前占比 - 目标占比
- 建议调仓金额 = 目标市值 - 当前市值

配置保存前校验也放在这里：

- 配置名称非空
- 总金额大于 0
- 至少 1 个持仓
- 目标比例合计等于 100
- 同一配置内基金代码不可重复

### 3.3 导入解析层

`src/domain/importers.ts` 使用解析器注册机制。

解析器接口：

```ts
interface ImportParser {
  formatName: string;
  canParse(raw: unknown): boolean;
  extractCodes(raw: unknown): string[];
}
```

当前已注册：

- `fundAssistantParser`：支持自选基金助手导出结构 `fundListGroup[].funds[].code`
- `plainCodeArrayParser`：支持简单代码数组或对象数组，作为扩展示例

主流程：

1. 文本或文件内容先 `JSON.parse`
2. 按注册顺序选择第一个 `canParse` 成功的解析器
3. 提取代码
4. 去重、过滤空字符串
5. 返回导入结果或可读错误

这样后续新增导入格式时，只需要新增解析器并注册，不需要改动已有解析器逻辑。

### 3.4 数据请求层

`src/services/fundApi.ts` 是底层接口模块：

- `fetchFundSnapshot` 获取实时净值和基金名称
- `fetchHistoricalNavBeforeOrOn` 获取起始日或之前最近交易日历史净值
- 每次请求设置 10 秒超时
- 所有解析失败都记录响应状态和响应片段

`src/services/fundClient.ts` 是应用侧 quote 加载模块：

- 实时净值 1 分钟缓存
- 历史净值按 `code:startDate` 缓存
- 批量加载配置内基金
- 单只基金失败不影响其他基金展示
- 返回 `HoldingQuote`，计算层据此继续计算

### 3.5 存储层

`src/services/storage.ts` 使用版本化状态：

```ts
interface AppState {
  schemaVersion: 1;
  configs: PortfolioConfig[];
  primaryConfigId?: string;
  selectedConfigId?: string;
  fundCache: Record<string, FundSnapshot>;
  historicalCache: Record<string, HistoricalNav>;
}
```

在 Chrome 插件环境中使用 `chrome.storage.local`，在普通浏览器开发环境中回退到 `localStorage`。

## 4. 净值获取流程

### 4.1 实时净值

接口：

```text
GET https://fundgz.1234567.com.cn/js/{fundCode}.js?rt={timestamp}
```

返回是 JSONP：

```text
jsonpgz({...});
```

解析规则：

- 必须匹配 `jsonpgz(...)`
- `name` 必须存在
- `dwjz` 必须能转成有效数字
- `jzrq` 作为当前净值日期

### 4.2 历史净值主接口

接口：

```text
GET https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex={page}&pageSize=120
```

关键点：

- 该接口需要有效来源，否则会返回业务失败。
- 代码中使用 `referrer: "https://fund.eastmoney.com/"` 尝试按浏览器标准传递来源。
- 接口返回倒序净值列表，需要分页向前找起始日之前最近交易日。

### 4.3 历史净值备用接口

主接口失败时降级：

```text
GET https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code={code}&page={page}&per=20
```

该接口返回 JavaScript 文本，内部包含 HTML 表格。解析策略：

- 提取 `<tr>` 行
- 提取 `<td>` 单元格
- 第 1 列是净值日期
- 第 2 列是单位净值
- 分页向前找起始日之前最近交易日

备用接口需要在 `manifest.json` 中声明：

```json
"host_permissions": [
  "https://fundf10.eastmoney.com/*"
]
```

## 5. 本次卡点：历史净值返回格式异常

### 5.1 表象

用户录入基金后，实时净值可以获取到基金名称，但历史净值失败，页面显示：

```text
历史净值返回格式异常
```

导致结果中：

- 组合总市值为 0
- 累计收益为 -100%
- 每只基金当前占比为 0
- 建议显示“待重试”

### 5.2 排查方法

没有直接猜原因，而是按以下步骤排查：

1. 用 `curl` 请求实时净值接口，确认实时接口返回正常 JSONP。
2. 用 `curl` 请求历史净值接口并带 `Referer`，确认历史接口返回正常 JSON。
3. 用 `curl` 请求历史净值接口但不带 `Referer`，复现异常响应。
4. 对比两种响应 shape，确认代码触发“格式异常”的真实原因。

带 `Referer` 时返回正常：

```json
{
  "Data": {
    "LSJZList": [
      {
        "FSRQ": "2026-04-23",
        "DWJZ": "1.6580"
      }
    ]
  },
  "ErrCode": 0
}
```

不带有效 `Referer` 时返回：

```json
{
  "Data": "",
  "ErrCode": -999,
  "PageSize": 0
}
```

这就是“历史净值返回格式异常”的根因：不是 JSON 解析失败，而是接口业务拒绝后 `Data` 从对象变成了空字符串。

### 5.3 根因

Chrome 扩展环境中直接通过 `headers: { Referer: ... }` 设置来源并不可靠。

即使代码写了 `headers.Referer`，浏览器也可能忽略或禁止设置该请求头，导致东财历史净值接口返回 `ErrCode:-999`。

### 5.4 解决方案

修复策略分三层：

1. 主接口使用 `referrer` 和 `referrerPolicy`，通过浏览器允许的方式传递来源。
2. 主接口返回 `ErrCode:-999` 或结构异常时，自动降级到备用历史净值接口。
3. 主接口和备用接口都支持分页回溯，直到找到起始日之前最近交易日净值。

这避免了单个接口策略变化导致整个观测功能不可用。

## 6. 日志设计

日志封装在 `src/services/logger.ts`：

```ts
logDebug(scope, message, data)
logInfo(scope, message, data)
logWarn(scope, message, data)
logError(scope, message, data)
```

统一前缀：

```text
[Rebalancer]
```

关键日志点：

- `fundApi snapshot request:start`
- `fundApi snapshot response:status`
- `fundApi snapshot response:preview`
- `fundApi historical primary request:start`
- `fundApi historical primary response:status`
- `fundApi historical primary response:preview`
- `fundApi historical primary parse:invalid-shape`
- `fundApi historical primary:failed, fallback:start`
- `fundApi historical fallback parse:ok`
- `fundClient quotes load:start`
- `fundClient quotes load:item-ok`
- `fundClient quotes load:item-failed`
- `fundClient quotes load:done`

调试建议：

1. 打开 Chrome 扩展 Popup 的 DevTools。
2. 过滤 `[Rebalancer]`。
3. 如果历史净值失败，优先看 `invalid-shape` 里的 `errCode`、`dataType` 和响应片段。
4. 如果主接口失败但备用接口成功，应能看到 `fallback:start` 和 `fallback parse:ok`。

## 7. 失败隔离策略

单只基金失败不会阻塞整个配置。

实现方式：

- `loadQuotesForConfig` 对每只基金独立 `try/catch`
- 成功项返回 `status: "ready"`
- 失败项返回 `status: "failed"` 和可读错误
- 计算层对失败项按 0 市值处理，并在 UI 展示错误

这样当某只基金代码异常、接口超时或历史净值缺失时，其他基金仍能正常展示。

## 8. 缓存策略

实时净值：

- 缓存 key：基金代码
- TTL：1 分钟
- 手动刷新时强制绕过缓存

历史净值：

- 缓存 key：`基金代码:起始日期`
- 不设置短 TTL，因为历史净值对同一日期基本稳定
- 手动刷新时可强制重新获取

## 9. 后续维护建议

1. 如果东财主接口再次变化，先看日志中的 `response:preview` 和 `invalid-shape`，不要直接改解析规则。
2. 如果备用接口 HTML 结构变化，优先新增解析分支并保留旧解析，避免回归。
3. 如果要支持更多数据源，建议新增 `HistoricalNavProvider` 抽象，而不是把更多分支继续塞进 UI。
4. 如果要做自动化测试，优先覆盖：
   - 导入解析器
   - 历史净值分页选择逻辑
   - `ErrCode:-999` 降级路径
   - 单只基金失败隔离
