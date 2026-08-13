/**
 * Mint a session key, and say what to do with it.
 *
 * This exists because the alternative was a one-line `node -e` long enough to
 * wrap twice on a phone terminal, which is where this actually gets run. The
 * key never touches the repo: it is printed once, for the operator to paste
 * into .env, and this script keeps no copy.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);

console.log("");
console.log("  SESSION_KEY_PRIVATE_KEY=" + key);
console.log("");
console.log("  address: " + address);
console.log("");
console.log("  1. paste the line above into /root/tessera/.env");
console.log("  2. send that address ~2 USDC for gas");
console.log("  3. ./scripts/deploy.sh");
console.log("");
