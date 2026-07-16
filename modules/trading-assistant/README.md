# 交易助理模块

模块目录：`modules/trading-assistant`

本模块负责：

- 股票候选池生成
- 分板块推荐
- 买卖点触发判断
- 缠论与技术面辅助分析
- 建仓、加仓、止损、止盈计划
- 剔除候选确认
- 推荐追踪与历史复盘
- 数据刷新、审计与策略回顾

## 文件结构

| 路径 | 用途 |
|---|---|
| `server.js` | 交易助理本地服务与 API |
| `trading-assistant.html` | 交易助理 Web 页面 |
| `data/` | 交易助理快照、追踪池、策略日志、审计结果 |
| `scripts/` | 数据刷新、审计、策略复盘脚本 |
| `logs/` | 定时刷新日志 |

## 常用命令

在项目根目录执行：

```powershell
npm run trade
npm run refresh:trade
npm run audit:trade
```

也可以直接进入模块目录：

```powershell
cd "D:\AI Tool\Projects\stock-ai-assistant-prototype\modules\trading-assistant"
node server.js
node scripts/refresh-trading-assistant.js
node scripts/audit-trading-assistant-data.js
```

## 数据刷新说明

刷新不是简单填充最新数据，而是会重新计算：

- 候选池
- 今日行动清单
- 买卖点状态
- 交易计划
- 剔除建议
- 推荐追踪池
- 数据源失败明细

如果某个数据源失败，页面会显示具体失败源，并使用已验证的替代源补充；无法补充的数据会显性标注，不允许伪造。

## 后续维护约定

当需求指向本模块时，请使用以下说法之一：

- “修改交易助理模块”
- “模块：交易助理”
- “只改 `modules/trading-assistant`”

没有明确指向交易助理时，后续宏观、产业链、公司分析等模块应在各自目录中开发。
