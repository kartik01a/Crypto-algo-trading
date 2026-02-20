# Crypto Algorithmic Trading Backend

Production-ready crypto algorithmic trading backend built with Node.js and Express.

## Features

- **Strategy Engine**: EMA(9) + EMA(21) + RSI(14) strategy
- **Risk Management**: Position sizing, stop loss, take profit, daily limits
- **Backtesting**: Historical simulation with realistic fees and slippage
- **Paper Trading**: Live simulation running every 1 minute
- **Real Trading**: CoinDCX API integration with live orders
- **Portfolio Tracking**: Balance, open/closed trades, equity curve

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose (trade persistence)
- ccxt (Binance for backtest/paper)
- CoinDCX API (real trading)
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

### Portfolio & Trades

```bash
GET /api/portfolio     # Portfolio summary (paper trading)
GET /api/trades        # All trades from DB (?mode=backtest|paper|real)
GET /api/trades/:mode  # Trades by mode
GET /api/performance   # Performance metrics (?mode=)
```

### Real Trading (CoinDCX)

```bash
POST /api/real/start   # Start real trading
POST /api/real/stop    # Stop real trading
GET  /api/real/status  # Status: isRunning, balance, openTrade, dailyLoss
```

**Environment variables:**
- `COINDCX_API_KEY` - CoinDCX API key
- `COINDCX_SECRET` - CoinDCX secret
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
    /coindcx   - CoinDCX API integration
    /execution - Trade execution (simulation)
    /portfolio - Portfolio tracking
    /backtest  - Backtest engine
    /paper     - Paper trading engine
    /real      - Real trading engine (CoinDCX)
  /services
  /utils
  app.js
```
