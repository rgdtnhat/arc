import { arcTestnet } from "@tessera/shared";
import { createProviderApp } from "./app.js";
import { CATALOG } from "./catalog.js";
import type { Hex } from "viem";

/**
 * Standalone provider server for a real deployment (e.g. against Arc testnet).
 * Provide one PROVIDER_KEY_<RESOURCE> per service, or a single PROVIDER_PRIVATE_KEY
 * used for all of them.
 */
const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const escrowAddress = process.env.TESSERA_ESCROW_ADDRESS as Hex;
const port = Number(process.env.PORT ?? 8788);

if (!escrowAddress) {
  console.error("Set TESSERA_ESCROW_ADDRESS to the deployed escrow.");
  process.exit(1);
}

const shared = process.env.PROVIDER_PRIVATE_KEY as Hex | undefined;
const providerKeys: Record<string, Hex> = {};
for (const svc of CATALOG) {
  const specific = process.env[`PROVIDER_KEY_${svc.resource.replace(/[:.]/g, "_").toUpperCase()}`] as
    | Hex
    | undefined;
  const key = specific ?? shared;
  if (key) providerKeys[svc.resource] = key;
}

const app = createProviderApp({
  chain: arcTestnet,
  rpcUrl,
  escrowAddress,
  providerKeys,
  onEvent: (e) => console.log(`[provider:${e.resource}] ${e.kind} — ${e.detail}`),
});

app.listen(port, () => console.log(`Tessera providers listening on :${port}`));
