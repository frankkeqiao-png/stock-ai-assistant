# 股票 AI 决策助手

这是一个按模块隔离开发的股票 AI 决策系统原型。

当前已完成并冻结边界的模块：

| 模块 | 目录 | 说明 |
|---|---|---|
| 交易助理 | `modules/trading-assistant` | 选股、候选池、买卖点触发、交易计划、剔除确认、推荐追踪 |

## 启动

```powershell
cd "D:\AI Tool\Projects\stock-ai-assistant-prototype"
& "C:\Users\surface\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
```

访问：

```text
http://127.0.0.1:8765/
```

## 模块边界约定

- 交易助理相关页面、服务端、数据、脚本、日志全部放在 `modules/trading-assistant/`。
- 后续开发宏观、产业链、公司情况等模块时，应建立新的 `modules/<module-name>/` 目录。
- 除非明确要求集成，否则新模块不要修改交易助理目录内的文件。
- 如果要继续修改交易助理，请在需求里写明“交易助理模块”或“模块：交易助理”。

