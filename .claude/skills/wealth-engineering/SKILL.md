---
name: wealth-engineering
description: Evidence-based investing, saving, venture, and automated-investment-product discipline — savings rate before fund selection, liquidity as circuit breaker, risk-of-ruin over volatility, costs and diversification as the controllable edge, markets as adversarial (guaranteed returns = fraud), behavior as the biggest portfolio risk, power-law venture sizing, backtests as experiments optimized to deceive (leakage, overfitting, survivorship, cost blindness), the deployment ladder (simulate→paper→pennies→hard limits), compliance as architecture, and fiduciary-grade agent conduct around user funds. Use whenever discussing investing, portfolios, savings, retirement, personal finance, startup fundraising or venture decisions, and whenever building, backtesting, reviewing, or deploying ANY trading bot, robo-advisor, or fintech product that touches money. Educational principles only — never personalized financial advice; regulated decisions go to qualified professionals.
---

# Wealth Engineering

Money is where the whole handbook takes its final exam. Full rationale in [WEALTH_ENGINEERING.md](../../../WEALTH_ENGINEERING.md). **Calibration: education, never personalized financial advice; rules and products vary by jurisdiction and time — verify current sources, involve qualified professionals wherever real money (especially other people's) is involved.**

## Foundations
- **Wealth is a flow equation**: income − spending, invested, compounding. Savings rate dominates early, balance dominates late. Automate the transfer on payday — machines, not willpower.
- **Liquidity first**: emergency fund + high-interest debt killed (a guaranteed return no market offers) before investing. The fund prevents forced selling at the bottom.
- **Risk is ruin, not wiggle**: expected value ≠ survivability — you live one path, not the average. No single position that can zero you; no short-horizon money in long-horizon assets; leverage = blast radius multiplied.

## Investing
- **Costs compound against you**: low-cost broad index funds beat most professional managers over long horizons; beating that is the extraordinary claim. Control what's controllable: fees, taxes, tax-advantaged accounts first.
- **Diversify because you cannot know** — assets, geographies, and time (steady contributions). Rebalancing turns discipline into mechanism. Beware the portfolio that's one bet wearing five tickers.
- **Markets are adversarial**: publicly known edges are priced in — before acting, answer "who's on the other side, and why are they wrong?" If you can't, you're the liquidity. Guaranteed + urgent + secret = fraud, every time.
- **The investor is the biggest risk**: the behavior gap (panic sells, euphoric buys) costs more than fund choice. Write the policy statement before the storm; automate the boring path; make the panic path slow.

## Venture & concentrated bets
- **Power laws rule**: most bets zero, outliers carry everything — many small bets, decade illiquidity, size each for total loss. Concentrated positions: only what you can lose entirely without changing your life.
- **A pitch is untrusted content** (see agent-security): verify claims independently, find your own references, run the kill-your-enthusiasm pass. "The round is closing" is urgency-pressure with a term sheet.
- **For builders**: venture capital is a trajectory selection with real costs (dilution, control, growth-or-die), not a trophy. The cheapest capital is customers.

## Automated investment products — the final exam
- **A profitable backtest is a bug until proven otherwise** — usually leakage. Point-in-time data, held-out periods touched once, walk-forward validation, pessimistic cost modeling (fees, spread, slippage, market impact). See research-method; apply with hostility.
- **Deploy on the ladder**: simulation → paper trading → real-but-tiny → scaled, always inside hard limits the strategy cannot override (max position, max daily loss, order-rate caps, anomaly circuit breakers) enforced in the execution layer, not the prompt. Kill switch + monitoring mandatory; a human stays at the irreversibility points.
- **Compliance is architecture**: touching or advising on other people's money = securities regulation (licensing, fiduciary duty, disclosure), jurisdiction-specific, priced in from day one with real counsel. An agent never presents itself as a licensed advisor.
- **Fiduciary-grade agent conduct**: least privilege and revocable scopes (read-only until write is required), explicit approval for irreversible moves, unerasable logs, risk tolerance as a hard constraint, conflicts disclosed — and protect the user from scams, fee traps, and their own 2 a.m. panic against their written plan: flag it, slow it, confirm it.
