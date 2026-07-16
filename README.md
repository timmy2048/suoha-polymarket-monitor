# Suoha Polymarket Sports Monitor

这是一个只读的 Polymarket 体育监控服务，包含两套推送边界：

- 跟单机器人：接收大额成交和 Top Holder 持仓提醒，当前范围都是世界杯，可通过配置扩展其他体育赛事。
- 地址机器人：只接收地址清单中钱包的已成交 BUY/SELL 动作。

服务不使用私钥、不下单，只访问 Polymarket 公共 API。

## 安装

```powershell
npm install
Copy-Item .env.example .env
```

将需要监控的钱包和大额市场范围写入 `config/watchlist.json`：

```json
{
  "largeTradeScopes": ["world-cup", "nba/games", "atp/games"],
  "wallets": [
    { "address": "0x0000000000000000000000000000000000000000", "label": "example", "enabled": true }
  ]
}
```

`wallets` 中的示例地址必须替换为真实地址。地址监控默认关闭，确认 Webhook 和地址后设置：

```dotenv
ADDRESS_MONITOR_ENABLED=true
```

## 市场范围配置

`largeTradeScopes` 是大额成交监控的范围，不会扫描 Polymarket 全站：

- `world-cup`：世界杯体育分类。
- `tennis/games`：所有网球赛事。
- `atp/games`：ATP 赛事。
- `basketball/games`：所有篮球赛事。
- `nba/games`：NBA 赛事。

目录通过 Gamma Sports 元数据、tag、series 和 event 的 condition ID 建立。成交数据随后按 condition ID、event slug、market slug 匹配；无法解析的范围会被跳过，不会误把全站成交当成目标市场。

## 监控规则

### 大额成交

- 全局阈值：`LARGE_TRADE_THRESHOLD_USDC`，默认 `500000`。
- 候选 API 预过滤：`LARGE_TRADE_MIN_CANDIDATE_USDC`，默认 `50000`。
- 单笔成交：`size * price >= LARGE_TRADE_THRESHOLD_USDC` 立即提醒。
- 拆单累计：同一钱包、市场、方向、Outcome 在 `LARGE_TRADE_CUMULATIVE_WINDOW_SECONDS` 内累计达到阈值提醒。
- 默认 30 秒轮询，可通过 `LARGE_TRADE_POLL_INTERVAL_SECONDS` 调整。

### Top Holder

- 默认通过 `HOLDER_EVENT_SCOPE_PATHS=world-cup` 监控世界杯比赛事件，不监控冠军或长期市场；后续可以配置 `nba/games`、`atp/games` 等赛事范围。
- 监控窗口按赛事类型计算：`HOLDER_SPORT_WINDOWS` 的格式为 `sport:开赛前分钟:开赛后分钟`。默认足球 `30/105`、篮球 `30/180`、网球 `30/240`，不会把足球的 105 分钟硬套到其他运动。
- 未配置某个 sport 时，回退到 `PREMATCH_MONITOR_MINUTES` 和 `MATCH_MONITOR_DURATION_MINUTES`。
- 目标为胜平负、让分 1.5/2.5、全场大小球 1.5 至 7.5 的 YES/NO，Top1。
- 成本按 `当前份额 * 平均买入价` 计算，达到 `THRESHOLD_USDC` 才提醒。
- 同一钱包和 Outcome 后续成本增加 `HOLDER_CHANGE_ALERT_USDC` 才再次提醒。
- 赛程每日在 `SCHEDULE_REFRESH_TIME_LOCAL`（Asia/Shanghai）刷新，服务启动时也会立即刷新。

### 地址监控

- 范围是 Polymarket Sports 目录，通过 `ADDRESS_SPORTS_SCOPE_PATHS` 配置，默认 `sports`。
- 无金额门槛，每一笔已成交 BUY/SELL 都监控。
- 同一钱包、市场、Outcome、方向的第一笔立即推送。
- 后续 5 分钟内合并，窗口结束推送一条聚合消息。
- 标题明确区分 `[BUY][首仓]`、`[BUY][加仓]`、`[SELL][首笔]`、`[SELL][继续卖出]`。
- 默认 30 秒轮询，使用 `ADDRESS_LOOKBACK_OVERLAP_SECONDS` 做时间重叠并通过状态去重。

## 钉钉配置

大额成交和 Top Holder 使用大额机器人；地址监控使用独立机器人：

```dotenv
DINGTALK_LARGE_TRADE_WEBHOOK_URL=
DINGTALK_LARGE_TRADE_SECRET=
DINGTALK_LARGE_TRADE_KEYWORD=跟单

DINGTALK_ADDRESS_WEBHOOK_URL=
DINGTALK_ADDRESS_SECRET=
DINGTALK_ADDRESS_KEYWORD=sport
```

加签机器人填写对应 `*_SECRET`。Webhook 和 Secret 只写本地 `.env` 或 VPS 上的 `.env`，不要提交 GitHub。

启动后跟单机器人会收到启动通知，包含阈值、轮询间隔、目录刷新间隔和 Holder 窗口；地址机器人不发送启动通知，只发送目标地址成交动作。

## 运行和验证

```powershell
npm run typecheck
npm test
npm run once
npm run start
```

`npm run once` 会刷新市场目录和世界杯赛程，执行三类扫描并打印结果；如果未配置 Webhook，提醒打印到终端。

运行时文件：

- `data/state.json`：去重、地址游标、地址聚合和 Holder 上次提醒状态。
- `data/alerts.ndjson`：大额成交和 Holder 提醒历史。
- `data/address-alerts.ndjson`：地址提醒历史。

## VPS 部署

```powershell
$env:VPS_HOST="your-host"
$env:VPS_USER="root"
$env:VPS_PORT="22"
$env:VPS_PASSWORD="your-password"
python scripts/deploy_vps.py
python scripts/check_vps_monitor.py
```

部署脚本不会上传本地 `.env`。VPS 上需要预先维护 `/opt/suoha-polymarket-monitor/.env`，并确认两个钉钉 Webhook 都在远端环境变量中。systemd 服务名为 `suoha-polymarket-monitor.service`。
## Sports expansion

The configured watchlist now includes MLB, UFC, ATP/WTA/ITF and doubles
tennis, cricket leagues, WNBA/BSN/NBA, NFL/CFL/CFB, PLL/WLL, and the listed
soccer competitions. Canonical aliases and official Polymarket
`sportsMarketType` rules are documented in `docs/sports-market-catalog.md`.
Large trades use every market in `largeTradeScopes`; Top Holder uses only the
configured game-level Holder types. The default Holder lookahead is three
calendar days and can be changed with `HOLDER_SCHEDULE_LOOKAHEAD_DAYS`.
