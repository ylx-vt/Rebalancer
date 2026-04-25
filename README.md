# Rebalancer

Rebalancer 是一个基金组合再平衡观测 Chrome 插件。它在浏览器 Popup 中完成组合录入、净值拉取、偏离计算和调仓金额提示，帮助用户判断当前基金组合是否偏离目标配置。

当前版本：`1.0.0`

## 功能

- 管理多个基金组合配置，并设置主配置
- 录入组合总金额、起始日期、目标比例和持仓基金
- 支持现金持仓，用于保留组合内现金比例
- 支持 JSON 文本导入和 JSON 文件导入
- 自动获取基金实时净值、历史净值和基金名称
- 计算当前市值、收益、持仓偏离和建议买卖金额
- 观测页提供概览、偏离、明细三种视图
- 单只基金数据失败时隔离展示，不阻塞其他持仓
- 数据保存在 `chrome.storage.local`，开发环境回退到 `localStorage`

## 支持的导入格式

自选基金助手导出结构：

```json
{
  "fundListGroup": [
    {
      "funds": [
        { "code": "000001" },
        { "code": "110022" }
      ]
    }
  ]
}
```

简单代码数组：

```json
["000001", "110022"]
```

或对象数组：

```json
[
  { "code": "000001" },
  { "code": "110022" }
]
```

## 数据来源

- 实时净值：`fundgz.1234567.com.cn`
- 历史净值主接口：`api.fund.eastmoney.com/f10/lsjz`
- 历史净值备用接口：`fundf10.eastmoney.com/F10DataApi.aspx`

历史净值会按起始日期向前查找最近交易日。主接口失败时会自动降级到备用接口。

## 本地开发

```bash
npm install
npm run dev
```

构建 Chrome 插件产物：

```bash
npm run build
```

构建产物位于 `dist/`。在 Chrome 扩展管理页开启开发者模式后，选择 `dist/` 作为未打包扩展加载。

## 技术栈

- Manifest V3
- TypeScript
- React
- Vite

## 文档

- [开发设计文档](docs/development-design.md)
- [产品需求文档](PRD.md)
