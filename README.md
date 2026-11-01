# Reasonix Token HUD

[![npm version](https://img.shields.io/npm/v/reasonix-token-hud.svg)](https://www.npmjs.com/package/reasonix-token-hud)
[![npm license](https://img.shields.io/npm/l/reasonix-token-hud.svg)](./LICENSE)

GitHub: <https://github.com/beijiangwx/dsh-reasonix-token-hud>

DeepSeek Harness 的右侧栏插件：实时监控**当前会话**的 token 用量、上下文占用与会话费用，并在底栏显示账户余额。

> 名字里的 “Reasonix” 只是向 Reasonix 的 HUD 思路致敬；本项目是独立的 DSH 插件，与 DeepSeek-Reasonix 项目没有隶属或背书关系。

- **右侧栏「用量与费用」标签页** —— 费用大数字、上下文占用条、四类 token 明细、费用构成、按模型/峰谷拆分，以及可编辑的计价设置。
- **对话头部费用胶囊** —— 始终显示的实时估算费用，点击直接打开侧栏标签页；会话还没有用量时自动隐藏。
- **对话底栏余额胶囊** —— 和「缓存命中」同一行的账户余额（走宿主自带的 Account Remote，与「设置 → 账户」同源），点击立即刷新；未登录或只有 API Key 时自动隐藏。
- 没有轮询会话数据：所有用量数字来自 Session 投影（projection）推送，随事件实时更新，断线重连后自动恢复。

## 界面

```
┌ 用量与费用 ───────────────────────┐
│ ● 运行中                 侧边栏用量插件 │
│ ¥0.0832                            │
│ 本会话估算 · CNY · 7 次计费 · 已省 ¥0.03 │
│ ┌──────────────────────────────┐ │
│ │ 上下文占用              72% │ │
│ │ ██████████████░░░░ 92.0K / 128K │
│ └──────────────────────────────┘ │
│ Token 用量            缓存命中 96% │
│ 1,200   48,000   0   3,400        │
│ 未缓存输入 缓存读取 缓存写入 输出    │
│ ┌ 费用构成                  ¥0.0832 ┐
│ │ ███████████████░░░░              │
│ │ ● 未缓存输入  1,200   ¥0.0024    │
│ │ ● 缓存读取   48,000   ¥0.0019    │
│ │ ● 输出        3,400   ¥0.0272    │
│ └ 缓存命中已省 ¥0.031 ─────────────┘
│ 按模型                    7 次请求 │
│ deepseek-flash             ¥0.0832 │
│ 51.6K tokens  [峰 30.9K] [闲 20.7K]│
│ ⚙ 计价设置 · CNY / 百万 tokens      │
│ 数据来自本次会话的用量投影……        │
└────────────────────────────────────┘

输入框下方（底栏）：
  12 turns · 34 steps   缓存命中 96%   余额 ¥123.45   ◔
```

## 数据从哪来

| 投影 | 提供方 | 用途 |
| --- | --- | --- |
| `usageMeter` | **本插件的 Host 半** | 按 provider/model 与高峰/空闲时段拆分的计费总量 |
| `tokenUsage` | `@deepseek-ai/dsh-token-meter` | 未缓存输入、缓存读取、缓存写入、输出总量（Host 半缺失时的回退） |
| `contextPressure` | 同上 | 下一次请求预计占用的上下文、上下文窗口 |
| `contextBreakdown` | 同上 | 系统 / 工具 / 消息的近似构成 |

为什么要自己的投影：内置 `tokenUsage` 只有总量，没有「哪一次请求发生在高峰还是空闲」。本插件在 Host 侧折叠 `session/event` 时给每个用量样本打上时段与模型标签，再让界面按标签计价，因此跨峰谷边界的会话不会被整体按「当前时段」错算。

### 余额的来源

余额不是 Session 投影：它通过宿主自带的一等 Account Remote（`ctx.remote.account.getBalance`）读取，和「设置 → 账户」显示的是同一份平台余额（充值钱包 + 赠送钱包）。底栏胶囊出现时读一次，之后每 5 分钟刷新；点胶囊立即重查。未登录、只有 API Key、或组合里没有 account 服务时拿不到余额，胶囊自动隐藏。

## 计价规则

默认值取 DeepSeek 官方 CNY 价目（每百万 tokens，模型 `deepseek-flash` / DeepSeek-V4.1-Flash）：

| 项目 | 高峰 | 空闲 |
| --- | --- | --- |
| 输入（未命中缓存） | ¥2.00 | ¥1.00 |
| 缓存读取 | ¥0.04 | ¥0.02 |
| 缓存写入 | 按输入价 | 按输入价的一半 |
| 输出 | ¥8.00 | ¥4.00 |

- 高峰：北京时间周一至周五 09:00–12:00、14:00–18:00；其余时间（含周末全天）为空闲。
- 中国法定节假日没有建模，会按高峰计价，只会让估算偏高。
- 单价可在面板「计价设置」里修改，保存在浏览器 `localStorage`（键 `reasonix-token-hud/rates/v1`），对头部胶囊立即生效。
- 价格来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（错峰规则同样来自该页）。
- 所有金额都是**估算**，以官方账单为准。

## 安装

### npm / tarball

```bash
# 发布到 npm 之后
dsh plugin add reasonix-token-hud

# 或者直接用打包好的 tarball
dsh plugin add ./reasonix-token-hud-1.0.1.tgz
```

### Desktop（本机 profile）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做两件事：

1. 把本目录复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\reasonix-token-hud`；
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
# reasonix-token-hud
- insert:
    - id: reasonix-token-hud
      name: 'reasonix-token-hud'
```

然后重启 DeepSeek Harness。

也可以手动完成上面两步。不想改 `package.json` / 依赖：这个插件不依赖任何 npm 包，直接放进 profile 的 `node_modules` 并由 patch 插入即可，`pnpm` 不会参与。

### Web profile

把目录放到对应 profile 的 `node_modules`，并在该 profile 的 `cordis.patch.yml` 追加同一段 `insert`，重启 `dsh web`。

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

或删除 `node_modules/reasonix-token-hud` 目录，并从 `cordis.patch.yml` 删掉上面那段。

## 兼容性

- DSH `>= 0.2.0`（在 `0.2.1-rc.5` 上开发）。
- 需要组合提供 `sessionProjections` 与右侧栏；两者都是 Web / Desktop 默认组合的一部分。
- Host 半缺失时插件仍可用：费用按内置 `tokenUsage` 总量、当前时段单价估算，面板会明确标注。

## 目录

```
lib/index.js      Host 半：注册 usageMeter 投影
lib/fold.js       投影的纯折叠逻辑（可单测）
lib/client.js     浏览器半：右侧栏标签页 + 头部费用胶囊 + 底栏余额胶囊
cordis.patch.yml  插入 Host 入口
install.ps1       安装到 Desktop profile
uninstall.ps1     卸载
test/             Node 单元测试
LICENSE           MIT
CHANGELOG.md      版本记录
```

## 开发

```powershell
node --test test/
```

或使用 DSH 自带的 Node（本机）：

```powershell
& "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --test test
```

测试覆盖：峰谷判定、用量替换/重试语义、按模型与时段拆桶、视图记忆化、价格计算、组件在完整/回退/空数据下的渲染、Host 注册契约。
