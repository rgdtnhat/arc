// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20F {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IFeePool {
    function supply(address asset, uint256 amount) external;
}

interface IFeeVault {
    function deposit(uint256 assets) external returns (uint256);
}

interface IFeeSwap {
    function seed(address token, uint256 amount) external;
}

interface IFeeAmm {
    function fund(uint256 poolId, address token, uint256 amount) external;
}

/**
 * @title TesseraFeeCollector
 * @notice The single account every app fee lands in, and the scheduler that
 *         redistributes it.
 *
 * Fees accrue here (100% of the app's take). On each `allocate()` the balance is
 * split across four sinks plus a retained remainder, using admin-set shares that
 * must total 100%:
 *
 *   - **agent**    — tops up the operating wallet that pays for agent calls
 *   - **lending**  — supplied to `TesseraPool` as the app's own position
 *   - **vault**    — deposited into `TesseraVault` (app-owned shares)
 *   - **swap**     — seeded into `TesseraSwap` inventory so quotes stay fillable,
 *                    or funded into a `TesseraAMM` pool when `amm` is set
 *   - **retained** — stays here as a buffer
 *
 * The same contract serves as the **AMM fee collector**: deploy a second instance,
 * point `amm` at a `TesseraAMM` pool, and the app's half of every AMM swap fee is
 * split 20% back into that pool, 20% lending, 20% vault, 20% agent, 20% retained.
 *
 * Defaults are 20/20/20/20/20. `allocate()` is permissionless but rate-limited by
 * `interval` (default 7 days), so anyone — a keeper, a cron, or the admin's
 * "Allocate now" button — can trigger it on schedule; `allocateNow()` is
 * owner-only and ignores the interval for manual runs.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraFeeCollector {
    uint16 internal constant BPS = 10_000;

    IERC20F public immutable asset; // the fee currency (USDC)
    address public owner;

    address public agent; // operating wallet
    address public pool; // TesseraPool
    address public vault; // TesseraVault
    address public swap; // TesseraSwap
    /// @notice Optional TesseraAMM. When set, the swap leg funds `ammPoolId` instead
    ///         of seeding the swap desk — this is what makes an AMM fee collector.
    address public amm;
    uint256 public ammPoolId;

    struct Shares {
        uint16 agentBps;
        uint16 lendingBps;
        uint16 vaultBps;
        uint16 swapBps;
        uint16 retainedBps;
    }
    Shares public shares;

    /// @notice Minimum seconds between permissionless `allocate()` calls.
    uint32 public interval;
    uint64 public lastAllocatedAt;

    bool private _locked;

    event Allocated(
        uint256 total,
        uint256 toAgent,
        uint256 toLending,
        uint256 toVault,
        uint256 toSwap,
        uint256 retained
    );
    event SharesSet(uint16 agentBps, uint16 lendingBps, uint16 vaultBps, uint16 swapBps, uint16 retainedBps);
    event IntervalSet(uint32 seconds_);
    event SinksSet(address agent, address pool, address vault, address swap);
    event AmmSet(address amm, uint256 poolId);
    event Swept(address token, uint256 amount, address to);

    modifier nonReentrant() {
        require(!_locked, "reentrancy");
        _locked = true;
        _;
        _locked = false;
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address asset_, address agent_, address pool_, address vault_, address swap_) {
        require(asset_ != address(0), "zero asset");
        asset = IERC20F(asset_);
        owner = msg.sender;
        agent = agent_;
        pool = pool_;
        vault = vault_;
        swap = swap_;
        // Default split: 20% to each sink, 20% retained.
        shares = Shares(2_000, 2_000, 2_000, 2_000, 2_000);
        interval = 7 days; // default cadence: once a week
        lastAllocatedAt = uint64(block.timestamp);
    }

    // --- views ----------------------------------------------------------------

    function balance() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Seconds until a permissionless `allocate()` is allowed (0 = now).
    function timeUntilAllocatable() external view returns (uint256) {
        uint256 next = uint256(lastAllocatedAt) + interval;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }

    // --- allocation -----------------------------------------------------------

    /// @notice Distribute the collected fees. Permissionless once `interval` has elapsed.
    function allocate() external nonReentrant {
        require(block.timestamp >= uint256(lastAllocatedAt) + interval, "too soon");
        _allocate();
    }

    /// @notice Owner-triggered distribution that ignores the interval ("Allocate now").
    function allocateNow() external onlyOwner nonReentrant {
        _allocate();
    }

    function _allocate() internal {
        uint256 total = asset.balanceOf(address(this));
        lastAllocatedAt = uint64(block.timestamp);
        if (total == 0) {
            emit Allocated(0, 0, 0, 0, 0, 0);
            return;
        }
        Shares memory s = shares;
        uint256 toAgent = (total * s.agentBps) / BPS;
        uint256 toLending = (total * s.lendingBps) / BPS;
        uint256 toVault = (total * s.vaultBps) / BPS;
        uint256 toSwap = (total * s.swapBps) / BPS;

        // Each leg is best-effort: one misconfigured or paused sink must not
        // block the others, and anything undelivered simply stays retained.
        if (toAgent > 0 && agent != address(0)) {
            if (!asset.transfer(agent, toAgent)) toAgent = 0;
        } else {
            toAgent = 0;
        }
        if (toLending > 0 && pool != address(0)) {
            asset.approve(pool, toLending);
            try IFeePool(pool).supply(address(asset), toLending) {} catch {
                toLending = 0;
            }
        } else {
            toLending = 0;
        }
        if (toVault > 0 && vault != address(0)) {
            asset.approve(vault, toVault);
            try IFeeVault(vault).deposit(toVault) {} catch {
                toVault = 0;
            }
        } else {
            toVault = 0;
        }
        if (toSwap > 0 && amm != address(0)) {
            // AMM mode: fees go back into the pool, lifting the value of every LP
            // share in it — the app's own position included.
            asset.approve(amm, toSwap);
            try IFeeAmm(amm).fund(ammPoolId, address(asset), toSwap) {} catch {
                toSwap = 0;
            }
        } else if (toSwap > 0 && swap != address(0)) {
            asset.approve(swap, toSwap);
            // `seed` is owner-only on the swap desk; if this collector isn't its
            // owner the call reverts and the amount stays retained here.
            try IFeeSwap(swap).seed(address(asset), toSwap) {} catch {
                toSwap = 0;
            }
        } else {
            toSwap = 0;
        }
        uint256 retained = asset.balanceOf(address(this));
        emit Allocated(total, toAgent, toLending, toVault, toSwap, retained);
    }

    // --- admin ----------------------------------------------------------------

    /// @notice Set the allocation split. Must total exactly 100%.
    function setShares(
        uint16 agentBps,
        uint16 lendingBps,
        uint16 vaultBps,
        uint16 swapBps,
        uint16 retainedBps
    ) external onlyOwner {
        require(
            uint256(agentBps) + lendingBps + vaultBps + swapBps + retainedBps == BPS,
            "shares must total 100%"
        );
        shares = Shares(agentBps, lendingBps, vaultBps, swapBps, retainedBps);
        emit SharesSet(agentBps, lendingBps, vaultBps, swapBps, retainedBps);
    }

    /// @notice Set the permissionless cadence, in seconds (1s … 365d).
    function setInterval(uint32 seconds_) external onlyOwner {
        require(seconds_ >= 1 && seconds_ <= 365 days, "interval");
        interval = seconds_;
        emit IntervalSet(seconds_);
    }

    function setSinks(address agent_, address pool_, address vault_, address swap_) external onlyOwner {
        agent = agent_;
        pool = pool_;
        vault = vault_;
        swap = swap_;
        emit SinksSet(agent_, pool_, vault_, swap_);
    }

    /// @notice Route the swap leg into an AMM pool instead of the swap desk.
    ///         Pass `address(0)` to fall back to seeding `swap`.
    function setAmm(address amm_, uint256 poolId_) external onlyOwner {
        amm = amm_;
        ammPoolId = poolId_;
        emit AmmSet(amm_, poolId_);
    }

    /// @notice Recover any token sent here (e.g. a non-fee asset).
    function sweep(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "zero");
        require(IERC20F(token).transfer(to, amount), "sweep");
        emit Swept(token, amount, to);
    }

    function transferOwnership(address o) external onlyOwner {
        require(o != address(0), "zero");
        owner = o;
    }
}
