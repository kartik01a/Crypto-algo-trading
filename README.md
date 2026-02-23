# Crypto Algorithmic Trading Backend

Production-ready crypto algorithmic trading backend built with Node.js and Express.

## Features

- **Strategy Engine**: EMA(9) + EMA(21) + RSI(14) strategy
- **Risk Management**: Position sizing, stop loss, take profit, daily limits
- **Backtesting**: Historical simulation with realistic fees and slippage
- **Paper Trading**: Live simulation running every 1 minute
- **Real Trading**: Binance Futures API with native trailing stop (no app dependency for exits)
- **Portfolio Tracking**: Balance, open/closed trades, equity curve

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose (trade persistence)
- ccxt (Binance for backtest/paper)
- Binance Futures API (real trading)
- technicalindicators

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

Server runs on `http://localhost:3000`

## API Endpoints

### Backtest

```bash
POST /api/backtest
Content-Type: application/json

{
  "symbol": "BTC/USDT",
  "timeframe": "5m",
  "from": "2024-01-01",
  "to": "2024-02-01",
  "initialBalance": 10000
}
```

### Paper Trading

```bash
POST /api/paper/start   # Start paper trading
POST /api/paper/stop    # Stop paper trading
GET  /api/paper/status  # Get status
```

**Start with Golden Cross HTF strategy:**
```bash
curl -X POST http://localhost:3000/api/paper/start \
  -H "Content-Type: application/json" \
  -d '{"symbol": "BTC/USDT", "strategy": "goldenCrossHTF", "initialBalance": 10000}'
```

**Long-only (BUY signals only, no shorts):**
```bash
curl -X POST http://localhost:3000/api/paper/start \
  -H "Content-Type: application/json" \
  -d '{"symbol": "ETH/USDT", "strategy": "goldenCrossHTF", "initialBalance": 10000, "longOnly": true}'
```

**INR pairs (for 10000 INR capital):**
```bash
curl -X POST http://localhost:3000/api/paper/start \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["ETH/INR","BTC/INR"], "strategy": "goldenCrossHTF", "initialBalance": 10000, "longOnly": true}'
```

**Multi-symbol (Golden Cross HTF):**
```bash
curl -X POST http://localhost:3000/api/paper/start \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["BTC/USDT","ETH/USDT","SOL/USDT"], "strategy": "goldenCrossHTF", "initialBalance": 10000, "maxOpenTrades": 3}'
```

Strategies: `trendPullback` (5m+15m), `goldenCrossHTF` (4h+1d), or omit for default EMA+RSI.

### Portfolio & Trades

```bash
GET /api/portfolio     # Portfolio summary (paper trading)
GET /api/trades        # All trades from DB (?mode=backtest|paper|real)
GET /api/trades/:mode  # Trades by mode
GET /api/performance   # Performance metrics (?mode=)
```

### Real Trading (Binance Futures)

App places entry + trailing stop once; Binance handles exit natively—no app dependency for stop updates.

```bash
POST /api/real/start   # Start real trading
POST /api/real/stop    # Stop real trading
GET  /api/real/status  # Status: isRunning, balance, openTrade, dailyLoss
```

**Start with Golden Cross HTF:**
```bash
curl -X POST http://localhost:3000/api/real/start \
  -H "Content-Type: application/json" \
  -d '{"symbol": "BTC/USDT", "strategy": "goldenCrossHTF", "longOnly": true}'
```

**Multi-symbol (Golden Cross HTF):**
```bash
curl -X POST http://localhost:3000/api/real/start \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["BTC/USDT","ETH/USDT","SOL/USDT"], "strategy": "goldenCrossHTF", "longOnly": true, "maxOpenTrades": 3}'
```

- `strategy`: `goldenCrossHTF` (4h+1d) | `trendPullback` (5m+15m) | omit for default
- `longOnly`: `true` = skip SELL signals (longs only)
- `useExchangeStopLoss`: `true` (default) = place trailing stop on Binance; `false` = app-managed SL
- `trailPercent`: `0.02` (default) = 2% trailing stop on Binance

**Environment variables:**
- `BINANCE_API_KEY` - Binance Futures API key
- `BINANCE_SECRET` - Binance Futures API secret
- `DRY_RUN=true` - Simulate orders (no real execution)
- `KILL_SWITCH_LOSS_PERCENT=10` - Stop trading if loss exceeds %

## Strategy Rules

**BUY**: EMA9 > EMA21 AND RSI < 30  
**SELL**: EMA9 < EMA21 AND RSI > 70

## Risk Parameters

- Risk per trade: 1%
- Max trades per day: 3
- Max daily loss: 5%
- Max drawdown: 10%
- Stop loss: 1.5%
- Take profit: 3%

## Project Structure

```
/src
  /config      - Configuration
  /modules
    /strategy  - EMA + RSI strategy
    /risk      - Risk management
    /exchange  - ccxt exchange wrapper (Binance)
    /binance   - Binance Futures API (real trading)
    /execution - Trade execution (simulation)
    /portfolio - Portfolio tracking
    /backtest  - Backtest engine
    /paper     - Paper trading engine
    /real      - Real trading engine (Binance Futures)
  /services
  /utils
  app.js
```
