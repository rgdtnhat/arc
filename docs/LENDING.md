# TesseraPool — lending & borrowing

`TesseraPool` is an isolated money market on Arc. Agents put idle stablecoins to
work (supply → yield) or open a credit line (borrow against collateral) to fund
their pay-per-call operations — and the protocol takes a fee that accrues to the
app-owner treasury.

> ⚠️ Unaudited — Arc testnet only. Requires a security audit before mainnet or real funds.

## 🔴 Live on Arc testnet

| Contract | Address |
|---|---|
The pool address is written to `deployments/arc.json` by `npm run pool:arc`.

Reserves are three **real Circle assets on Arc**, all borrowable:

| Asset | Role |
|---|---|
| **USDC** (`0x3600…0000`) | stablecoin + gas token |
| **EURC** (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`) | euro stablecoin |
| **cirBTC** (`0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`) | Circle Wrapped Bitcoin — collateral |

Liquidity is seeded from the deployer's real balances and the agent opens a
cirBTC-collateralised USDC credit line. Deploy/refresh with `npm run pool:arc`;
the live dashboard reads the reserves + position straight from Arc.

## How it works

| Concept | In TesseraPool |
|---|---|
| **Isolated pool** with independent **reserves** | `addReserve(asset, …)`; each asset has its own config + accounting |
| **Collateral factor** / **liability factor** per reserve | `cFactor` (how much an asset backs borrowing) and `lFactor` (how much borrowing it consumes of your limit), both in bps |
| **Utilization-driven interest** | a kinked rate model: gentle to an 80% target utilization (`KINK`), steep beyond — pushing utilization back toward target |
| **Backstop take-rate** (protocol revenue) | `reserveFactor`: a cut of interest is minted to the `treasury` (the app-owner's fee) |
| **Health-factor liquidation** | `liquidate()` repays an unhealthy borrower's debt and seizes collateral at a 10% bonus, capped by a 50% close factor |

Interest accrues on an **index/share model**: suppliers hold supply-shares whose
asset value grows with accrued interest; borrowers hold debt-shares whose value
grows with the borrow rate. Prices come from an admin/oracle (`setPrice`), so a
price move can make a position liquidatable — exactly as in the tests.

## API

```solidity
// admin
addReserve(asset, cFactor, lFactor, reserveFactor, borrowable, decimals, price)
setPrice(asset, price)               // oracle
setTreasury(address)                 // where the protocol fee goes

// users / agents
supply(asset, amount)                // earn yield, becomes collateral
withdraw(asset, amount)              // blocked if it would make you insolvent
borrow(asset, amount)                // against your collateral, health-checked
repay(asset, amount) / repayFor(asset, user, amount)
liquidate(user, debtAsset, collateralAsset, repayAmount)

// views (for agents / dashboards)
accountData(user)   → (supplyValue, borrowValue, borrowLimit, healthFactor)  // USD 1e8, HF in WAD
reserveData(asset)  → (cash, totalBorrows, utilization, borrowApr, supplyApr) // WAD
supplyBalance(asset, user) / borrowBalance(asset, user)
```

## Example (from the tests)

- Alice supplies **1,000 USDC** of liquidity → earns the supply APR.
- Bob supplies **1 wBTC ($30k)** as collateral (70% collateral factor → $21k limit)
  and borrows **USDC** against it.
- A year passes: Bob's debt grows at the borrow APR, Alice's balance grows at the
  supply APR, and the **treasury accrues its `reserveFactor` cut**.
- wBTC drops to **$22k** → Bob's health factor falls below 1 → a liquidator repays
  part of his USDC debt and seizes his wBTC at a **10% bonus**.

Run the suite: `npm test` (7 pool tests in `contracts/test/TesseraPool.test.ts`).

## Agent integration (live on Arc)

`npm run pool:arc` deploys `TesseraPool` on Arc with three real Circle reserves
(USDC + EURC + cirBTC, all borrowable), seeds liquidity from the deployer's
balances, gives the agent cirBTC collateral, and runs a **lending pre-flight**:
the agent supplies its collateral and draws a small USDC credit line against it.
The dashboard's **Lending & borrowing** panel lets you pick any asset and see its
reserve (liquidity, utilization, borrow/supply APR) and your position (supplied,
borrowed, wallet), with **Supply / Withdraw / Borrow / Repay** at a **custom or
Max** amount, executing on-chain. The agent reaches the pool through
Agent Stack actions: `pool_supply`, `pool_withdraw`, `pool_borrow`, `pool_repay`,
`pool_account`, `pool_reserve` (`agent/src/pool.ts`, `agent/src/agentkit.ts`).

## Roadmap

- A dedicated **backstop module** (first-loss LP capital that earns the take-rate).
- **Reactive interest rates** that adjust the curve toward target utilization
  over time rather than a fixed kink.
- A **price oracle** feed for the reserves in place of the static admin prices.
