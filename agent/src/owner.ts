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
    privateKey: Hex,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.pub = createPublicClient({ chain, transport: pacedHttp(rpcUrl), batch: { multicall: true } });
    this.wallet = createWalletClient({ account: this.account, chain, transport: pacedHttp(rpcUrl) });
  }

  /** Build from env; returns null when no deployer key is configured. */
  static fromEnv(chain: Chain, rpcUrl: string): OwnerClient | null {
    const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
    return key ? new OwnerClient(chain, rpcUrl, key) : null;
  }

  private async send(address: Hex, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await this.pub.simulateContract({
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
      account: this.account,
    });
    const hash = await this.wallet.writeContract(request as never);
    await confirm(this.pub, hash);
    return hash;
  }

  /**
   * Generic owner-signed call, for contracts whose admin surface is broad enough
   * that a named wrapper per function would just be noise (the AMM, for example).
   */
  write(address: Hex, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
    return this.send(address, abi, functionName, args);
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
