# Reasonix Token HUD · dsh-go

Reasonix Token HUD 的手机原生适配版：不依赖 Harness Web Client，直接在 dsh-go 的输入框上方显示一条实时状态。

- npm：`reasonix-token-hud-dshgo`
- GitHub：<https://github.com/beijiangwx/dsh-reasonix-token-hud/tree/main/dshgo>
- Cordis（网页 / 桌面）版仍是 `reasonix-token-hud`，两者互不干扰。

## 安装

```sh
dsh plugin --profile web add reasonix-token-hud-dshgo
```

安装后打开 App；如果状态条没出现，到「引擎」页重启一次引擎。

## 在哪看

- **输入框上方状态条**：`¥0.083 · 96K · 余¥12`（余额拿不到时省略）。
- **点状态条**：打开「用量与费用」面板，含费用、tokens、缓存命中、上下文占用、四类 token、按模型费用、峰谷与缓存节省。
- **「复制用量」动作**：输入框操作菜单里，把本次会话摘要复制到剪贴板。
- 面板也会出现在对话详情的「插件」页签和「全部功能」里。

## 数据口径

- 费用为估算：输入 ¥2 / 缓存读取 ¥0.04 / 输出 ¥8（每百万 tokens）；高峰为北京时间工作日 09–12、14–18，空闲半价。
- 余额来自引擎的 `deepseekAccount.getBalance`；平台余额接口不可达时显示 `—`，不影响 token 与费用统计。
- 扫描当前会话事件，按 `turn:step` 替换、重试另计，与 token-meter 的 `tokenUsage` 口径一致；按样本时间区分峰谷。

## 开发

```sh
node /root/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load
```

`lib/` 改动后需在 App 的「引擎」页重启引擎。

## License

MIT
