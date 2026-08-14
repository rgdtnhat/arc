import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tesseraVaultAbi, tesseraFeeCollectorAbi, pacedHttp } from "@tessera/shared";
import { confirm } from "./confirm.js";

/**
 * Signs the **owner-gated** contract calls — the ones the deploying key owns, not
 * the agent's operating key. `TesseraVault.setParams`, the fee collector's
 * `setShares` / `setInterval` / `allocateNow` are all `onlyOwner`, and the
 * deployer is the owner, so calling them with the agent account reverts with
 * "not owner".
 *
 * Requires `DEPLOYER_PRIVATE_KEY`. Without it these operations are unavailable
 * and the API says so instead of failing with a confusing revert.
 */
export class OwnerClient {
  readonly account: Account;
  private readonly pub: ReturnType<typeof createPublicClient>;
  private readonly wallet: ReturnType<typeof createWalletClient>;

  constructor(
    private readonly chain: Chain,
    rpcUrl: string,
    signer: Hex | Account,
  ) {
    this.account = typeof signer === "string" ? privateKeyToAccount(signer) : signer;
    this.pub = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
    this.wallet = createWalletClient({ account: this.account, chain, transport: pacedHttp(rpcUrl) });
  }

  /** Build from env; returns null when no deployer key is configured. */
  static fromEnv(chain: Chain, rpcUrl: string): OwnerClient | null {
    const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
    return key ? new OwnerClient(chain, rpcUrl, key) : null;
  }

  /**
   * The same signing machinery, driven by an account that is not the deployer.
   *
   * Not every call the server makes on a user's behalf is owner-gated. The app
   * wallet claims its *own* rewards, supplies its *own* liquidity — ordinary
   * calls where the only thing that matters is which address is `msg.sender`.
   * Those still want the gas margin and the receipt check in this class, and
   * they must go through the `Account` the rest of the app already built, so a
   * `WALLET_MODE=circle` deployment keeps signing through Circle rather than
   * quietly falling back to a raw key.
   */
  /**
   * A signer built from a key that is not the deployer's.
   *
   * The session key is the case this exists for: an address whose whole
   * authority is what other wallets have delegated to it, which must never be
   * the deployer and must still get this class's gas margin and receipt check.
   */
  static fromKey(chain: Chain, rpcUrl: string, key: Hex): OwnerClient {
    return new OwnerClient(chain, rpcUrl, key);
  }

  static forAccount(chain: Chain, rpcUrl: string, account: Account): OwnerClient {
    return new OwnerClient(chain, rpcUrl, account);
  }

  /**
   * How much more gas to send than the node says is needed.
   *
   * `eth_estimateGas` binary-searches for a limit the call survives, and a
   * limit that *just* survives the search is not always a limit that survives
   * execution. The emitter is where this bites: its activity views wrap every
   * reserve read in `try/catch`, and a `try` forwards only 63/64 of the gas
   * remaining, so the last inner call in a chain can come up short at exactly
   * the estimated limit while a slightly looser one sails through.
   *
   * Two live transactions were mined with `gasUsed` exactly equal to their
   * limit before this existed — a retired sink weight and the keeper's first
   * round — and both succeeded on the next attempt using *less* gas than the
   * estimate, once there was headroom for the search to be a little wrong.
   * Unspent gas is refunded, so the only cost of the margin is a higher
   * up-front balance requirement.
   */
  private static readonly GAS_NUMERATOR = 3n;
  private static readonly GAS_DENOMINATOR = 2n;
  private static readonly GAS_FLOOR = 50_000n;

  private async send(address: Hex, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await this.pub.simulateContract({
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
      account: this.account,
    });
    const gas = await this.gasFor(address, abi, functionName, args);
    const hash = await this.wallet.writeContract({ ...(request as object), ...(gas ? { gas } : {}) } as never);
    await confirm(this.pub, hash);
    return hash;
  }

  /** The estimate plus its margin, or null if the node will not estimate. */
  private async gasFor(address: Hex, abi: unknown, functionName: string, args: unknown[]): Promise<bigint | null> {
    try {
      const est = await this.pub.estimateContractGas({
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
        account: this.account,
      });
      return (est * OwnerClient.GAS_NUMERATOR) / OwnerClient.GAS_DENOMINATOR + OwnerClient.GAS_FLOOR;
    } catch {
      // A call that will not estimate will not send either; let `writeContract`
      // produce the real error rather than inventing a limit for it.
      return null;
    }
  }

  /**
   * Generic owner-signed call, for contracts whose admin surface is broad enough
   * that a named wrapper per function would just be noise (the AMM, for example).
   */
  write(address: Hex, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
    return this.send(address, abi, functionName, args);
  }

  /**
   * Send calldata this class did not build.
   *
   * The one caller is the transfer memo: an ABI-encoded `transfer` with the
   * memo's bytes appended after it. Solidity's decoder ignores trailing
   * calldata, so the call executes exactly as the encoded arguments say and
   * the memo rides along in the transaction's input, where an explorer will
   * show it. `writeContract` cannot express that — it encodes from the ABI —
   * so this drops to `sendTransaction`.
   *
   * It keeps the two things that make the rest of this class safe: the gas
   * margin, and waiting for a receipt rather than trusting a broadcast. The
   * caller is expected to have simulated first; see `transferWithMemo`.
   */
  async sendRaw(to: Hex, data: Hex): Promise<Hex> {
    let gas: bigint | null = null;
    try {
      const est = await this.pub.estimateGas({ account: this.account, to, data });
      gas = (est * OwnerClient.GAS_NUMERATOR) / OwnerClient.GAS_DENOMINATOR + OwnerClient.GAS_FLOOR;
    } catch {
      // A call that will not estimate will not send either; let the send
      // produce the real error rather than inventing a limit for it.
    }
    const hash = await this.wallet.sendTransaction({
      account: this.account, chain: this.chain, to, data, ...(gas ? { gas } : {}),
    } as never);
    await confirm(this.pub, hash);
    return hash;
  }

  /** Would this calldata succeed right now? Used to test a memo before sending. */
  async callWouldSucceed(to: Hex, data: Hex): Promise<boolean> {
    try {
      await this.pub.call({ account: this.account, to, data });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deploy a contract from the deployer key and wait for it to land.
   *
   * Used by the admin "create a replacement" flow. It returns the address only
   * once the receipt confirms one, so a caller can never end up recording a
   * contract that isn't actually there.
   */
  async deploy(abi: unknown, bytecode: Hex, args: unknown[]): Promise<Hex> {
    const hash = await this.wallet.deployContract({
      abi: abi as never,
      bytecode,
      args: args as never,
      account: this.account,
      chain: this.chain,
    } as never);
    const receipt = await confirm(this.pub, hash);
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error("Deployment reverted — nothing was created.");
    }
    return receipt.contractAddress as Hex;
  }

  /** Is this account actually the owner of `contract`? */
  async isOwnerOf(contract: Hex, abi: unknown): Promise<boolean> {
    try {
      const owner = (await this.pub.readContract({
        address: contract,
        abi: abi as never,
        functionName: "owner" as never,
      })) as Hex;
      return owner.toLowerCase() === this.account.address.toLowerCase();
    } catch {
      return false;
    }
  }

  // --- vault ----------------------------------------------------------------

  /** Push the reserve ratio + performance fee on-chain (contract re-checks both). */
  setVaultParams(vault: Hex, reserveRatioBps: number, performanceFeeBps: number): Promise<Hex> {
    return this.send(vault, tesseraVaultAbi, "setParams", [reserveRatioBps, performanceFeeBps]);
  }

  // --- fee collector --------------------------------------------------------

  setFeeShares(
    collector: Hex,
    s: { agentBps: number; lendingBps: number; vaultBps: number; swapBps: number; retainedBps: number },
  ): Promise<Hex> {
    return this.send(collector, tesseraFeeCollectorAbi, "setShares", [
      s.agentBps,
      s.lendingBps,
      s.vaultBps,
      s.swapBps,
      s.retainedBps,
    ]);
  }

  setFeeInterval(collector: Hex, seconds: number): Promise<Hex> {
    return this.send(collector, tesseraFeeCollectorAbi, "setInterval", [seconds]);
  }

  allocateNow(collector: Hex): Promise<Hex> {
    return this.send(collector, tesseraFeeCollectorAbi, "allocateNow", []);
  }
}
