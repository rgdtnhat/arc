// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TesseraToken (TSRA)
 * @notice The protocol's own token: one hundred billion, minted once, never
 *         again.
 *
 * ## Fixed means fixed
 * There is no `mint`, no owner, and no upgrade path. The entire supply exists
 * after the constructor returns and the constructor is the only code that ever
 * creates a unit. A token whose supply is "fixed by policy" is fixed until
 * somebody changes the policy; this one is fixed by the absence of a function.
 * That is the only version of the promise worth making, and it is why the
 * locking is done by a separate contract holding tokens rather than by this
 * one withholding them — a lock you can see the balance of beats a lock that
 * lives in an owner's restraint.
 *
 * ## Votes, and why they are not just balances
 * Governance needs to know what somebody held *at the moment a proposal
 * opened*, not what they hold when the vote is counted. Reading live balances
 * lets one pot of tokens vote on the same proposal from as many addresses as
 * it can be passed between, and lets anyone borrow weight for the length of a
 * block. So voting power is checkpointed: every transfer writes a historical
 * record, and `getPastVotes` answers as of a block that is already final.
 *
 * Power is delegated rather than implicit. Holding tokens gives you nothing
 * until you point that weight somewhere — at yourself or at somebody else.
 * Explicit delegation costs a transaction, and it buys a property worth having:
 * tokens sitting in an exchange's omnibus wallet, or in an AMM pool, are not
 * silently voting.
 *
 * ## Decimals
 * Eighteen, not six. USDC's six make sense for a unit pegged to a dollar; an
 * emission rate denominated per-second across a hundred billion tokens needs
 * the extra room, and every wallet and explorer assumes eighteen unless told.
 */
contract TesseraToken {
    string public constant name = "Tessera";
    string public constant symbol = "TSRA";
    uint8 public constant decimals = 18;

    /// One hundred billion, in whole tokens.
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 1e18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Who each holder's voting power is pointed at. Zero means nobody.
    mapping(address => address) public delegates;

    struct Checkpoint {
        uint32 fromBlock;
        uint224 votes;
    }
    mapping(address => Checkpoint[]) private _checkpoints;

    error ZeroAddress();
    error InsufficientBalance(uint256 have, uint256 want);
    error InsufficientAllowance(uint256 have, uint256 want);
    error FutureLookup(uint256 asked, uint256 current);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event DelegateChanged(address indexed delegator, address indexed from, address indexed to);
    event DelegateVotesChanged(address indexed delegate, uint256 previous, uint256 current);

    /**
     * @param treasury Receives the entire supply. Intended to be the emitter,
     *        so the tokens are locked behind a schedule from block one rather
     *        than sitting in a wallet that has to be trusted not to sell.
     */
    constructor(address treasury) {
        if (treasury == address(0)) revert ZeroAddress();
        totalSupply = MAX_SUPPLY;
        balanceOf[treasury] = MAX_SUPPLY;
        emit Transfer(address(0), treasury, MAX_SUPPLY);
    }

    // --- ERC-20 ---------------------------------------------------------------

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance(bal, amount);
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        _moveVotes(delegates[from], delegates[to], amount);
    }

    // --- votes ----------------------------------------------------------------

    /**
     * @notice Point your voting power at `to`. `address(0)` withdraws it.
     *
     * Self-delegation is the common case and still costs a transaction. That is
     * deliberate: an address that has never delegated has no voting power, so
     * tokens held by a contract that does not know about governance — a pool,
     * a bridge, an exchange — cannot be voted by whoever happens to control it.
     */
    function delegate(address to) external {
        address from = delegates[msg.sender];
        delegates[msg.sender] = to;
        emit DelegateChanged(msg.sender, from, to);
        _moveVotes(from, to, balanceOf[msg.sender]);
    }

    function _moveVotes(address from, address to, uint256 amount) internal {
        if (from == to || amount == 0) return;
        if (from != address(0)) {
            uint256 prev = _latest(from);
            _write(from, prev, prev - amount);
        }
        if (to != address(0)) {
            uint256 prev = _latest(to);
            _write(to, prev, prev + amount);
        }
    }

    function _latest(address who) internal view returns (uint256) {
        uint256 n = _checkpoints[who].length;
        return n == 0 ? 0 : _checkpoints[who][n - 1].votes;
    }

    function _write(address who, uint256 prev, uint256 next) internal {
        uint256 n = _checkpoints[who].length;
        if (n > 0 && _checkpoints[who][n - 1].fromBlock == uint32(block.number)) {
            // Several transfers in one block collapse into one record, so a
            // lookup for that block sees the end state rather than a partial.
            _checkpoints[who][n - 1].votes = uint224(next);
        } else {
            _checkpoints[who].push(Checkpoint({ fromBlock: uint32(block.number), votes: uint224(next) }));
        }
        emit DelegateVotesChanged(who, prev, next);
    }

    /// @notice Voting power right now.
    function getVotes(address who) external view returns (uint256) {
        return _latest(who);
    }

    /**
     * @notice Voting power as of the end of `blockNumber`.
     *
     * Refuses the current block and anything later. A snapshot of a block still
     * being built is not a snapshot — it can change under a voter between the
     * read and the vote, which is the whole thing checkpoints exist to prevent.
     */
    function getPastVotes(address who, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert FutureLookup(blockNumber, block.number);
        Checkpoint[] storage cps = _checkpoints[who];
        uint256 n = cps.length;
        if (n == 0) return 0;
        if (cps[n - 1].fromBlock <= blockNumber) return cps[n - 1].votes;
        if (cps[0].fromBlock > blockNumber) return 0;

        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (cps[mid].fromBlock <= blockNumber) lo = mid;
            else hi = mid - 1;
        }
        return cps[lo].votes;
    }

    /// @notice How many records `who` has. Useful for indexing and for tests.
    function checkpointCount(address who) external view returns (uint256) {
        return _checkpoints[who].length;
    }
}
