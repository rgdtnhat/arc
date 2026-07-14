import express, { type Express, type Request, type Response } from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEADERS,
  tesseraEscrowAbi,
  formatUsdc,
  PaymentStatus,
} from "@tessera/shared";
import { CATALOG, type ServiceDef } from "./catalog.js";
import { quoteHash, responseHash, randomNonce } from "./quote.js";

export interface ProviderConfig {
  chain: Chain;
  rpcUrl: string;
  escrowAddress: Hex;
  /** Private key per resource id — lets each service have its own reputation. */
  providerKeys: Record<string, Hex>;
  /** Optional sink for demo telemetry. */
  onEvent?: (e: ProviderEvent) => void;
}

export interface ProviderEvent {
  kind: "quote" | "verify" | "fulfill" | "reject" | "serve";
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

export function createProviderApp(config: ProviderConfig): Express {
  const app = express();
  app.use(express.json());

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
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
      createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl) })
    );
  }

  // quoteHash -> issued quote, so we can validate the on-chain payment references
  // a quote we actually handed out.
  const issued = new Map<string, IssuedQuote>();

  const emit = (e: ProviderEvent) => config.onEvent?.(e);

  // Discovery: what an agent can buy, with live on-chain reputation.
  app.get("/catalog", async (_req: Request, res: Response) => {
    const items = await Promise.all(
      CATALOG.filter((s) => addressOf.has(s.resource)).map(async (s) => {
        const provider = addressOf.get(s.resource)!;
        const [fulfilled, failed, earned] = (await publicClient.readContract({
          address: config.escrowAddress,
          abi: tesseraEscrowAbi,
          functionName: "reputation",
          args: [provider],
        })) as [bigint, bigint, bigint];
        return {
          resource: s.resource,
          name: s.name,
          tags: s.tags,
          path: s.path,
          price: s.price.toString(),
          priceUsdc: formatUsdc(s.price),
          slaSeconds: s.slaSeconds,
          provider,
          reputation: {
            fulfilled: Number(fulfilled),
            failed: Number(failed),
            earnedUsdc: formatUsdc(earned),
          },
        };
      })
    );
    res.json({ services: items });
  });

  for (const svc of CATALOG) {
    if (!addressOf.has(svc.resource)) continue;
    app.get(svc.path, (req, res) => handlePaid(svc, req, res));
  }

  async function handlePaid(svc: ServiceDef, req: Request, res: Response) {
    const provider = addressOf.get(svc.resource)!;
    const paymentId = req.header(HEADERS.payment);

    // --- Unpaid: issue a 402 quote -------------------------------------------
    if (!paymentId) {
      const nonce = randomNonce();
      const qh = quoteHash(provider, svc.price, svc.resource, nonce);
      issued.set(qh, {
        resource: svc.resource,
        price: svc.price,
        provider,
        expiresAt: Date.now() + svc.slaSeconds * 1000 + 60_000,
      });
      emit({ kind: "quote", resource: svc.resource, detail: `quoted ${formatUsdc(svc.price)} USDC` });
      res
        .status(402)
        .set({
          [HEADERS.provider]: provider,
          [HEADERS.price]: svc.price.toString(),
          [HEADERS.quote]: qh,
          [HEADERS.deadline]: String(svc.slaSeconds),
          [HEADERS.resource]: svc.resource,
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
    const [, payProvider, amount, , qHash, , status] = payment;

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

    const body = svc.respond(req.query as Record<string, string>);
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
      const txHash = await wallet.writeContract({
        address: config.escrowAddress,
        abi: tesseraEscrowAbi,
        functionName: "fulfill",
        args: [BigInt(paymentId), rHash],
        chain: config.chain,
        account: wallet.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      emit({
        kind: "fulfill",
        resource: svc.resource,
        detail: svc.behavior === "bad-data" ? `fulfilled with degraded data` : `fulfilled ${paymentId}`,
        txHash,
      });
      res.set(HEADERS.quote, rHash).json(body);
    } catch (err) {
      res.status(500).json({ error: "fulfillment failed", detail: String(err) });
    }
  }

  return app;
}
