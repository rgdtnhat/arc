# TesseraPool — lending & borrowing (Blend-inspired)

`TesseraPool` is an isolated money market on Arc, modelled on
[Blend](https://www.blend.capital/) (Stellar). Agents put idle USDC to work
(supply → yield) or open a credit line (borrow against collateral) to fund their
pay-per-call operations — and the protocol takes a fee that accrues to the
app-owner treasury.

> ⚠️ Unaudited demo code for Arc testnet. Not for production or real funds.

## What it borrows from Blend

| Blend concept | In TesseraPool |
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

## Agent integration (live in the demo)

The dashboard demo deploys `TesseraPool` on the local chain (USDC + wBTC reserves,
100 USDC seeded), gives the agent 0.5 wBTC ($15k) of collateral, and runs a
**lending pre-flight**: the agent supplies its collateral and draws a small USDC
credit line against it. The dashboard's **Lending & borrowing** panel shows the
USDC reserve (liquidity, utilization, borrow/supply APR) and the agent's live
position (supplied, borrowed, limit, health factor), with **Supply / Withdraw /
Borrow / Repay** buttons that execute on-chain. The agent reaches the pool through
Agent Stack actions: `pool_supply`, `pool_withdraw`, `pool_borrow`, `pool_repay`,
`pool_account`, `pool_reserve` (`agent/src/pool.ts`, `agent/src/agentkit.ts`).

## Roadmap

- A dedicated **backstop module** (first-loss LP capital that earns the take-rate),
  closer to Blend's full design.
- **Reactive interest rates** (Blend adjusts the curve toward target utilization
  over time) rather than a fixed kink.
- **Deploy TesseraPool to Arc testnet** (currently local-demo only) and expose the
  lending panel in live mode.
