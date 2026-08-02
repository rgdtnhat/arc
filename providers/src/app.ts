import express, { type Express, type Request, type Response } from "express";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  getAddress,
  keccak256,
  recoverMessageAddress,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEADERS,
  tesseraEscrowAbi,
  tesseraTabAbi,
  formatUsdc,
  PaymentStatus,
  quoteTypedData,
  receiptFromPayment,
  pacedHttp,
  type DefiOracle,
} from "@tessera/shared";
import { CATALOG, produceBody, type ServiceDef, type ServiceContext } from "./catalog.js";
import { quoteHash, responseHash, randomNonce } from "./quote.js";

export interface ProviderConfig {
  chain: Chain;
  rpcUrl: string;
  escrowAddress: Hex;
  /** TesseraTab contract for nanopayment (tab) billing. Optional. */
  tabAddress?: Hex;
  /** Private key per resource id — lets each service have its own reputation. */
  providerKeys: Record<string, Hex>;
  /** Optional sink for telemetry / dashboard events. */
  onEvent?: (e: ProviderEvent) => void;
  /**
   * Live DeFi reads, for the services that sell them. Optional: without it those
   * services report themselves unavailable rather than inventing an answer.
   */
  oracle?: DefiOracle;
}

export interface ProviderEvent {
  kind: "quote" | "verify" | "fulfill" | "reject" | "serve" | "tab";
  resource: string;
  detail: string;
  txHash?: string;
}

interface IssuedQuote {
  resource: string;
  price: bigint;
  provider: Hex;
  expiresAt: number;
}

/**
 * Canonical ledger key for a tab, or null if it isn't a usable id.
 *
 * The voucher ledger must be keyed by the tab's numeric identity, never by the
 * string a caller sent. Both the signature hash and the contract read go through
 * `BigInt(tabId)`, so "1", "01", "0x1" and " 1" are one tab on-chain under one
 * signature — but they are four distinct Map keys. Keying on the raw string let
 * a buyer replay a single voucher indefinitely: each spelling found no previous
 * voucher, `prev` fell back to the on-chain `claimed` value, and
 * `cum - prev >= price` passed again every time. The provider served N ticks and
 * could only ever claim one of them.
 *
 * Negatives are rejected as well as junk: `BigInt("-1")` parses happily and
 * would otherwise open a second namespace for a tab that cannot exist.
 */
export function tabKey(raw: string | undefined): string | null {
  // An empty or whitespace-only value is not an id. `BigInt("")` is 0n, so
  // without this an absent header would silently settle against tab 0. The
  // caller happens to reject falsy values first today; this function should not
  // depend on that.
  if (raw === undefined || raw.trim() === "") return null;
  let id: bigint;
  try {
    id = BigInt(raw.trim());
  } catch {
    return null;
  }
  return id >= 0n ? id.toString(10) : null;
}

export function createProviderApp(config: ProviderConfig): Express {
  const app = express();
  app.use(express.json());

  // Handed to every `respondAsync`, so a service can read live chain state
  // without standing up its own client or importing the agent.
  const serviceCtx: ServiceContext = {
    oracle: config.oracle,
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    escrowAddress: config.escrowAddress,
  };
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: pacedHttp(config.rpcUrl),
    pollingInterval: 8000,
    batch: { multicall: true },
  });

  // Resolve each service's provider wallet.
  const wallets = new Map<string, ReturnType<typeof createWalletClient>>();
  const addressOf = new Map<string, Hex>();
  for (const svc of CATALOG) {
    const key = config.providerKeys[svc.resource];
    if (!key) continue;
    const account = privateKeyToAccount(key);
    addressOf.set(svc.resource, account.address);
    wallets.set(
      svc.resource,
      createWalletClient({ account, chain: config.chain, transport: pacedHttp(config.rpcUrl) })
    );
  }

  // Serialize on-chain WRITES per provider wallet. Multiple agents can hit the
  // same provider at once; without this, concurrent writeContract calls reuse
  // the wallet's nonce and all but one fail (and hang waiting for a receipt).
  // Signing a quote sends no tx, so it stays concurrent — only txs are queued.
  const writeChains = new Map<string, Promise<unknown>>();
  function withWallet<T>(providerAddr: Hex, fn: () => Promise<T>): Promise<T> {
    const key = providerAddr.toLowerCase();
    const prev = writeChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the previous outcome
    writeChains.set(key, next.catch(() => {})); // don't leak rejections on the chain
    return next;
  }

  // quoteHash -> issued quote, so we can validate the on-chain payment references
  // a quote we actually handed out.
  const issued = new Map<string, IssuedQuote>();

  const emit = (e: ProviderEvent) => config.onEvent?.(e);

  // Discovery: what an agent can buy, with live on-chain reputation + stake.
  // All services here can share a provider wallet, so read each provider's
  // on-chain state ONCE (not once per service) to avoid bursting the RPC's
  // per-window eth_call limit, and fall back to the last-known value on a
  // transient failure so discovery never hangs.
  const repCache = new Map<Hex, { rep: [bigint, bigint, bigint]; stake: bigint }>();
  const readProviderState = async (provider: Hex) => {
    try {
      const [rep, stake] = await Promise.all([
        publicClient.readContract({
          address: config.escrowAddress,
          abi: tesseraEscrowAbi,
          functionName: "reputation",
          args: [provider],
        }) as Promise<[bigint, bigint, bigint]>,
        publicClient.readContract({
          address: config.escrowAddress,
          abi: tesseraEscrowAbi,
          functionName: "stakeOf",
          args: [provider],
        }) as Promise<bigint>,
      ]);
      const state = { rep, stake };
      repCache.set(provider, state);
      return state;
    } catch {
      return repCache.get(provider) ?? { rep: [0n, 0n, 0n] as [bigint, bigint, bigint], stake: 0n };
    }
  };

  app.get("/catalog", async (_req: Request, res: Response) => {
    const uniqueProviders = [...new Set(CATALOG.filter((s) => addressOf.has(s.resource)).map((s) => addressOf.get(s.resource)!))];
    const stateByProvider = new Map<Hex, { rep: [bigint, bigint, bigint]; stake: bigint }>();
    for (const p of uniqueProviders) stateByProvider.set(p, await readProviderState(p));
    const items =
      CATALOG.filter((s) => addressOf.has(s.resource)).map((s) => {
        const provider = addressOf.get(s.resource)!;
        const { rep: [fulfilled, failed, earned], stake } = stateByProvider.get(provider)!;
        return {
          resource: s.resource,
          name: s.name,
          tags: s.tags,
          path: s.path,
          price: s.price.toString(),
          priceUsdc: formatUsdc(s.price),
          slaSeconds: s.slaSeconds,
          billing: s.billing ?? "escrow",
          provider,
          stakeUsdc: formatUsdc(stake),
          reputation: {
            fulfilled: Number(fulfilled),
            failed: Number(failed),
            earnedUsdc: formatUsdc(earned),
          },
        };
      });
    res.json({ services: items });
  });

  for (const svc of CATALOG) {
    if (!addressOf.has(svc.resource)) continue;
    if (svc.billing === "tab") {
      app.get(svc.path, (req, res) => handleTab(svc, req, res));
    } else {
      app.get(svc.path, (req, res) => handlePaid(svc, req, res));
    }
  }

  // --- Payment requests (invoices) -------------------------------------------
  // Providers publish invoices; paying one is just buying the referenced
  // resource through the normal 402 escrow flow. Fulfillment marks it paid.
  const invoiceStatus = new Map<string, "pending" | "paid">();
  for (const svc of CATALOG) {
    if (svc.invoice && addressOf.has(svc.resource)) {
      invoiceStatus.set(svc.resource, "pending");
    }
  }

  app.get("/invoices", (_req: Request, res: Response) => {
    const invoices = CATALOG.filter((s) => s.invoice && invoiceStatus.has(s.resource)).map(
      (s) => ({
        invoiceId: s.resource,
        resource: s.resource,
        name: s.name,
        provider: addressOf.get(s.resource)!,
        amount: s.price.toString(),
        amountUsdc: formatUsdc(s.price),
        memo: s.invoice!.memo,
        status: invoiceStatus.get(s.resource)!,
      })
    );
    res.json({ invoices });
  });

  const markInvoicePaid = (resource: string) => {
    if (invoiceStatus.get(resource) === "pending") {
      invoiceStatus.set(resource, "paid");
      emit({ kind: "serve", resource, detail: "invoice settled — receipt issued" });
    }
  };

  // The best voucher seen per tab, so the provider can settle in one claim.
  //
  // Keyed by the tab's *numeric* identity, never by the string the caller sent.
  // Both the signature hash and the contract read use `BigInt(tabId)`, so "1",
  // "01", "0x1" and " 1" are one and the same tab on-chain and under one and the
  // same signature — but they are four different Map keys. Keying on the raw
  // string let a buyer replay a single voucher indefinitely: each spelling found
  // no previous voucher, so `prev` fell back to the on-chain `claimed` value and
  // `cum - prev >= price` passed again every time. The provider served N ticks
  // and could only ever claim one of them.
  const bestVoucher = new Map<string, { cum: bigint; sig: Hex; resource: string }>();


  /** Nanopayments: verify an off-chain voucher, then serve — zero gas per call. */
  async function handleTab(svc: ServiceDef, req: Request, res: Response) {
    const provider = addressOf.get(svc.resource)!;
    if (!config.tabAddress) {
      res.status(501).json({ error: "tab billing not configured" });
      return;
    }

    const rawTabId = req.header(HEADERS.tab);
    const voucher = req.header(HEADERS.voucher);
    const sig = req.header(HEADERS.voucherSig) as Hex | undefined;

    // Unpaid: advertise tab billing terms.
    if (!rawTabId || !voucher || !sig) {
      res
        .status(402)
        .set({
          [HEADERS.provider]: provider,
          [HEADERS.price]: svc.price.toString(),
          [HEADERS.billing]: "tab",
          [HEADERS.resource]: svc.resource,
        })
        .json({
          error: "payment required",
          billing: "tab",
          resource: svc.resource,
          pricePerCall: formatUsdc(svc.price),
          how: "openTab() on TesseraTab, then send x-tessera-tab / x-tessera-voucher / x-tessera-voucher-sig per call",
        });
      return;
    }

    // One canonical id from here down — the value the ledger, the signature and
    // the contract all agree on.
    const tabId = tabKey(rawTabId);
    if (tabId === null) {
      res.status(400).json({ error: "invalid tab id" });
      return;
    }

    // Verify the voucher: on-chain tab state + off-chain signature.
    const cum = BigInt(voucher);
    let tab: [Hex, Hex, bigint, bigint, bigint, boolean];
    try {
      tab = (await publicClient.readContract({
        address: config.tabAddress,
        abi: tesseraTabAbi,
        functionName: "tabs",
        args: [BigInt(tabId)],
      })) as [Hex, Hex, bigint, bigint, bigint, boolean];
    } catch (err) {
      // Never leave the request hanging on a transient RPC failure — the agent's
      // fetch would otherwise time out. Signal retryable and let it re-send.
      res.status(503).json({ error: "tab read failed", detail: String(err).slice(0, 120) });
      return;
    }
    const [tabAgent, tabProvider, deposit, claimed, , closed] = tab;

    const prev = bestVoucher.get(tabId)?.cum ?? claimed;
    const hash = keccak256(
      encodePacked(
        ["address", "uint256", "uint256"],
        [config.tabAddress, BigInt(tabId), cum]
      )
    );
    let signer: Hex | undefined;
    try {
      signer = await recoverMessageAddress({ message: { raw: hash }, signature: sig });
    } catch {
      signer = undefined;
    }

    const ok =
      !closed &&
      getAddress(tabProvider) === getAddress(provider) &&
      cum <= deposit &&
      cum - prev >= svc.price &&
      signer !== undefined &&
      getAddress(signer) === getAddress(tabAgent);

    if (!ok) {
      emit({ kind: "tab", resource: svc.resource, detail: `rejected voucher on tab #${tabId}` });
      res.status(402).json({ error: "invalid voucher" });
      return;
    }

    // Same live-read path as the escrow-billed services. A tab buyer is paying
    // for a feed of current positions; serving the sync placeholder here would
    // charge them for the string "unavailable".
    const produced = await produceBody(svc, req.query as Record<string, string>, serviceCtx);
    if (!produced.ok) {
      // Bank the voucher only once the tick has actually been served. A failed
      // read leaves the previous voucher as the best one, so the keeper is not
      // billed for it and can simply retry.
      emit({ kind: "tab", resource: svc.resource, detail: `tick failed — not billed (${produced.error.slice(0, 80)})` });
      res.status(503).json({ error: "live read unavailable", detail: produced.error.slice(0, 200) });
      return;
    }
    const body = produced.body;
    bestVoucher.set(tabId, { cum, sig, resource: svc.resource });
    emit({
      kind: "tab",
      resource: svc.resource,
      detail: `tick served — voucher now ${formatUsdc(cum)} USDC (off-chain, no gas)`,
    });
    res.json(body);
  }

  /** Agent asks the provider to settle its tab: one on-chain claim for N calls. */
  app.post("/tab/:tabId/close", async (req: Request, res: Response) => {
    const tabId = tabKey(req.params.tabId);
    const best = tabId === null ? undefined : bestVoucher.get(tabId);
    if (!config.tabAddress || tabId === null || !best) {
      res.status(404).json({ error: "no vouchers for this tab" });
      return;
    }
    try {
      const wallet = wallets.get(best.resource)!;
      const provider = addressOf.get(best.resource)!;
      const txHash = await withWallet(provider, async () => {
        const h = await wallet.writeContract({
          address: config.tabAddress!,
          abi: tesseraTabAbi,
          functionName: "closeTab",
          args: [BigInt(tabId), best.cum, best.sig],
          chain: config.chain,
          account: wallet.account!,
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
        return h;
      });
      bestVoucher.delete(tabId);
      emit({
        kind: "tab",
        resource: best.resource,
        detail: `tab #${tabId} settled on-chain for ${formatUsdc(best.cum)} USDC (1 tx for many ticks)`,
        txHash,
      });
      res.json({ settled: best.cum.toString(), txHash });
    } catch (err) {
      res.status(500).json({ error: "close failed", detail: String(err) });
    }
  });

  async function handlePaid(svc: ServiceDef, req: Request, res: Response) {
    const provider = addressOf.get(svc.resource)!;
    const paymentId = req.header(HEADERS.payment);

    // --- Unpaid: issue a 402 quote -------------------------------------------
    if (!paymentId) {
      const nonce = randomNonce();
      const qh = quoteHash(provider, svc.price, svc.resource, nonce);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + svc.slaSeconds + 60);
      issued.set(qh, {
        resource: svc.resource,
        price: svc.price,
        provider,
        expiresAt: Date.now() + svc.slaSeconds * 1000 + 60_000,
      });
      // EIP-712 sign the quote so the agent can verify it's authentic.
      const wallet = wallets.get(svc.resource)!;
      const typed = quoteTypedData(config.chain.id, config.escrowAddress, {
        provider,
        price: svc.price,
        resource: svc.resource,
        nonce,
        expiry,
      });
      const quoteSig = await wallet.signTypedData({ account: wallet.account!, ...typed });
      emit({ kind: "quote", resource: svc.resource, detail: `quoted ${formatUsdc(svc.price)} USDC (signed)` });
      res
        .status(402)
        .set({
          [HEADERS.provider]: provider,
          [HEADERS.price]: svc.price.toString(),
          [HEADERS.quote]: qh,
          [HEADERS.deadline]: String(svc.slaSeconds),
          [HEADERS.resource]: svc.resource,
          [HEADERS.quoteNonce]: nonce,
          [HEADERS.quoteExpiry]: expiry.toString(),
          [HEADERS.quoteSig]: quoteSig,
        })
        .json({
          error: "payment required",
          resource: svc.resource,
          price: formatUsdc(svc.price),
          how: "escrow on Arc via TesseraEscrow.open(), then retry with x-tessera-payment: <paymentId>",
        });
      return;
    }

    // --- Paid: verify the escrow on-chain before doing any work --------------
    let payment;
    try {
      payment = (await publicClient.readContract({
        address: config.escrowAddress,
        abi: tesseraEscrowAbi,
        functionName: "getPayment",
        args: [BigInt(paymentId)],
      })) as [Hex, Hex, bigint, bigint, Hex, Hex, number];
    } catch {
      res.status(400).json({ error: "unreadable paymentId" });
      return;
    }
    const [payAgent, payProvider, amount, , qHash, , status] = payment;

    const known = issued.get(qHash);
    const ok =
      getAddress(payProvider) === getAddress(provider) &&
      status === PaymentStatus.Escrowed &&
      amount >= svc.price &&
      known?.resource === svc.resource;

    if (!ok) {
      emit({ kind: "verify", resource: svc.resource, detail: `rejected payment ${paymentId}` });
      res.status(402).json({ error: "escrow not valid for this resource" });
      return;
    }
    emit({ kind: "verify", resource: svc.resource, detail: `escrow ${paymentId} verified (${formatUsdc(amount)} USDC)` });

    const produced = await produceBody(svc, req.query as Record<string, string>, serviceCtx);
    if (!produced.ok) {
      // A `liveOnly` service could not read the chain. Return 503 and do NOT
      // record delivery: the escrow stays open, so the buyer refunds after the
      // deadline rather than paying for an error object.
      emit({ kind: "serve", resource: svc.resource, detail: `live read failed — not delivered (${produced.error.slice(0, 80)})` });
      res.status(503).json({ error: "live read unavailable", detail: produced.error.slice(0, 200) });
      return;
    }
    const body = produced.body;
    emit({
      kind: "serve",
      resource: svc.resource,
      detail: produced.live ? "served live upstream data" : "upstream unreachable — served fallback",
    });
    const rHash = responseHash(body);

    // "no-fulfill": deliver data but never settle on-chain -> agent times out.
    if (svc.behavior === "no-fulfill") {
      emit({ kind: "serve", resource: svc.resource, detail: `served WITHOUT fulfilling (SLA will breach)` });
      res.json(body);
      return;
    }

    // Otherwise fulfill on-chain (honest hash), then return the body. For
    // "bad-data" the body itself is junk, so the agent's quality gate rejects it.
    try {
      const wallet = wallets.get(svc.resource)!;
      const txHash = await withWallet(provider, async () => {
        const h = await wallet.writeContract({
          address: config.escrowAddress,
          abi: tesseraEscrowAbi,
          functionName: "fulfill",
          args: [BigInt(paymentId), rHash],
          chain: config.chain,
          account: wallet.account!,
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
        return h;
      });
      emit({
        kind: "fulfill",
        resource: svc.resource,
        detail: svc.behavior === "bad-data" ? `fulfilled with degraded data` : `fulfilled ${paymentId}`,
        txHash,
      });
      markInvoicePaid(svc.resource);

      // Sign a receipt for what was actually served. The chain now says this
      // payment was fulfilled against `rHash`; the receipt is what ties that
      // hash to this body, this buyer, and this moment — the part a third party
      // would need to adjudicate a dispute.
      const issuedAt = BigInt(Math.floor(Date.now() / 1000));
      const receiptSig = await wallet.signTypedData({
        account: wallet.account!,
        ...receiptFromPayment(
          config.chain.id,
          config.escrowAddress,
          BigInt(paymentId),
          { agent: getAddress(payAgent), provider, amount, responseHash: rHash },
          svc.resource,
          issuedAt,
        ),
      });

      res
        .set({
          [HEADERS.quote]: rHash,
          [HEADERS.receiptSig]: receiptSig,
          [HEADERS.receiptIssued]: issuedAt.toString(),
        })
        .json(body);
    } catch (err) {
      res.status(500).json({ error: "fulfillment failed", detail: String(err) });
    }
  }

  return app;
}
