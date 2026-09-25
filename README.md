# PokerLab Camera AI Coach — OpenAI Vision 版

这个版本已经把 OpenAI 视觉识别真正接进后端。

## 实时流程

1. iPhone Safari 打开 HTTPS 网站。
2. 摄像头持续运行。
3. 前端约每 1.5 秒抓取一帧 JPEG。
4. `/api/analyze-table` 把图片发送到 OpenAI Responses API。
5. 视觉模型只负责识别：
   - 你的可见手牌
   - 公共牌
   - 底池
   - 需要跟注金额
   - 桌上人数
   - 当前街道
6. 后端自己的扑克算法计算：
   - 胜率
   - 平局率
   - Equity
   - Outs
7. 前端立即更新。

## 为什么概率不让 AI 直接算

视觉模型只负责“看图”。胜率和 Outs 用本地 Monte Carlo / 牌型算法计算，结果更稳定，也避免模型凭感觉报数字。

## 本地运行

Node.js 18+：

```bash
npm install
cp .env.example .env
```

然后设置环境变量：

```bash
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="gpt-6-astra"
npm start
```

Windows PowerShell：

```powershell
$env:OPENAI_API_KEY="你的 API Key"
$env:OPENAI_MODEL="gpt-6-astra"
npm start
```

打开：

`http://localhost:3000`

注意：电脑 localhost 可以运行，但 iPhone 实时摄像头建议部署到 HTTPS。

## 部署

可以部署到支持 Node.js 的服务，例如 Render、Railway、Fly.io 或自己的服务器。

需要设置环境变量：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`（默认 `gpt-6-astra`）

不要把 API Key 写进前端 HTML，也不要上传到公开 GitHub 仓库。

## 健康检查

部署后访问：

`/api/health`

应该看到：

```json
{
  "ok": true,
  "openai_key_configured": true,
  "model": "gpt-6-astra"
}
```

## 费用 / 延迟

当前前端约每 1.5 秒发送一帧。视觉请求会产生 API 使用费用，也可能受网络延迟影响。

实际使用时可以把间隔改为 2–3 秒，或者只在画面变化时调用，以降低费用。

## 训练建议

项目里的“训练建议”是根据计算出的 Equity 与底池赔率生成的练习提示。
真钱牌局中建议只查看客观数据并自行决定。
