/**
 * Revert reasons, turned into sentences a person can act on.
 *
 * This lived inside `friendlyError` in `dashboard.ts`, where nothing could
 * import it — so every test of the wording had to re-type the pattern it was
 * asserting about, and the copy in the test drifted from the copy that runs.
 * `refusal-wording.test.ts` was written that way and could not have caught a
 * rule that was missing from the real table, because the real table was not the
 * thing it read.
 *
 * It is pure data with no closure over anything, so it moves out whole. The
 * order is the meaning: the first pattern that matches wins, so a specific
 * reason has to appear above the generic `reverted` that always accompanies it.
 *
 * An empty message marks a sentence this app wrote itself. `friendlyError`
 * passes those through unchanged rather than replacing a precise reason with a
 * vague one.
 */
export const ERROR_TABLE: [RegExp, string][] = [
  [/request limit|rate limit|too many requests|429|-32005/, "The Arc network is rate-limiting us right now. Wait a few seconds and try again."],
  [/timeout|timed out|fetch failed|socket|econnreset|network/, "Couldn't reach the Arc network. Check your connection and try again."],
  [/noroute|no route/, "No AMM pool can fill that trade right now. Try a smaller amount, or add liquidity for the pair."],
  [/expired|deadline/, "The order sat too long before it was mined and expired. Try again — this protects you from being filled at a stale price."],
  [/badpath|bad path/, "That swap route isn't valid. Pick two different assets."],
  [/slippage/, "The price moved while the order was being sent. Get a fresh quote and try again."],
  [/pool illiquid/, "The pool doesn't have enough free liquidity for that amount right now. Try withdrawing less."],
  [/insufficientliquidity/, "The pool is fully lent out at the moment — not enough free liquidity. Try a smaller amount."],
  [/unhealthy/, "That would push your position below the safe collateral limit. Borrow less or add collateral."],
  [/min deposit/, "That first deposit is too small. Deposit a slightly larger amount."],
  [/same token/, "Pick two different assets to swap between."],
  [/no price/, "That asset has no price configured yet, so it can't be swapped."],
  [/zero ?amount|zero in|zero out|no shares|\bzero\b/, "Enter an amount greater than zero."],
  [/not borrowable/, "That asset can't be borrowed from this pool."],
  [/unknownreserve/, "That asset isn't a reserve in this pool."],
  /*
   * `ActionFrozen` — an operator has paused one action on one reserve.
   *
   * This was missing, so a frozen reserve fell all the way through to the
   * generic `reverted` rule and every scheduled supply and every scheduled
   * borrow reported "The contract rejected this transaction. Double-check the
   * amount and try again." The amount was never the problem, and no amount
   * would have worked: `frozenActions[asset] & action` is a switch, not a
   * limit. On this deployment all four reserves sat at mask 5
   * (`FREEZE_SUPPLY | FREEZE_BORROW`) after a half-finished pool redeploy, and
   * that sentence is the only thing tasks and task series said while they
   * failed.
   *
   * The revert carries no argument, so it cannot name which action or which
   * asset — but "an operator froze this" is the fact that stops somebody
   * retrying smaller numbers forever, and it is the fact an operator needs in
   * order to go and unfreeze it.
   */
  [/actionfrozen/, "That action is paused on this reserve — an operator has frozen it on the pool, so no amount will go through. Withdrawing and repaying are unaffected unless they are frozen too. An operator can lift it from the pool's admin controls."],
  [/insufficient liquidity/, "The pool is too shallow to fill that trade. Try a smaller amount, or add liquidity for the pair."],
  [/\breverted with the following reason:\s*in\b|"in"/, "Couldn't take your input token — approve it for the router first, and check the balance."],
  [/\breverted with the following reason:\s*out\b|"out"/, "Couldn't send the output token. The pool may have moved since the quote — get a fresh quote."],
  [/healthoutofband/, "That liquidation percentage would leave the borrower outside the target health band. Pick a percentage that lands them between 1.03 and 1.15."],
  [/noauction/, "There is no open auction for that account."],
  [/auctionexists/, "That account already has an open auction. Fill it or cancel it first."],
  [/stilllocked/, "Those backstop shares are still in the queue period. They unlock 21 days after they were queued."],
  /*
   * Session-key refusals, before the generic allowance rule below.
   *
   * Every one of these is a limit the wallet's owner set on purpose, and
   * naming the wrong one is worse than saying nothing: a cap that had run
   * out was being reported as "approve the spender first", which sends
   * somebody to re-approve a contract that is working exactly as asked.
   * The `allowance` rule matched because the honest explanation of a cap
   * mentions the allowance as one of the three things that bind.
   */
  [/pertxexceeded/, "That is more than this session's per-transfer limit. Send a smaller amount, or open a session with a higher limit."],
  [/capexceeded/, "This session has spent its whole cap. Open a new one to keep paying from that wallet."],
  [/sessionexpired/, "This session has expired. Open a new one to keep paying from that wallet."],
  [/sessionrevokederror|sessionrevoked|has been revoked/, "The wallet's owner revoked this session, so it can no longer spend."],
  [/session (has expired|can pay)|no such session|delegated to a different key/, ""],
  [/notsessionkey/, "This server is not the key that session was delegated to."],
  [/recipientnotallowed/, "That recipient is not on this session's allow-list."],
  [/whichever binds first/, ""],
  /*
   * Refusals this app made *before* sending anything.
   *
   * These reached the user as "That transaction didn't go through. the
   * lending pool on this deployment predates…", which reads as a
   * transaction that was sent and failed — and sends somebody looking at
   * their balance and the explorer for a transaction that never existed.
   * Nothing was submitted: the app checked, found the pool has no way to
   * act for a holder, and stopped. The sentence is already the right one,
   * so it is passed through whole.
   */
  /*
   * The same refusals, for when one has been embedded in a larger string on
   * its way here (`settleFailure` composes a sentence around
   * `friendlyError`) and the class no longer travels with it. Matched by the
   * part that is common to each pair rather than by either spelling.
   */
  [/predates scheduled |not authorised on that \w+ position|its own position/, ""],
  // A simulation that said no, before anything was signed. Already a whole
  // sentence — and one whose whole point is that no transaction exists.
  [/nothing was sent|that would fail, so nothing was touched/, ""],
  [/refusing new risk because/, ""],
  [/allowance|transferfrom/, "Token approval failed — approve the spender first, or check the wallet holds enough of that token."],
  [/exceeds balance|insufficient balance|\bbalance\b/, "Not enough balance for that amount."],
  [/insufficient funds|gas required|out of gas/, "Not enough USDC to cover network fees. Top up the wallet at faucet.circle.com."],
  [/nonce/, "A previous transaction is still settling. Wait a moment and try again."],
  [/user rejected|user denied/, "You cancelled the transaction in your wallet."],
  [/reverted/, "The contract rejected this transaction. Double-check the amount and try again."],
];

/**
 * The first rule that matches, or null.
 *
 * `haystack` is every place viem might have put the reason, lowercased and
 * joined — see `friendlyError`, which is what assembles it.
 */
export function matchErrorTable(haystack: string): [RegExp, string] | null {
  for (const rule of ERROR_TABLE) if (rule[0].test(haystack)) return rule;
  return null;
}
