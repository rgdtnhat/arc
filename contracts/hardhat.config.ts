import type { HardhatUserConfig } from "hardhat/config";
import chai from "chai";
import chaiAsPromised from "chai-as-promised";

// The two plugins this project actually uses, rather than
// `@nomicfoundation/hardhat-toolbox-viem`.
//
// The toolbox is an aggregator: it also pulls in hardhat-verify,
// hardhat-ignition-viem, hardhat-gas-reporter and solidity-coverage. None of
// those are used here — there is no ignition module, no coverage script, and
// REPORT_GAS is never set — but they dragged in the whole ethers v5 tree, and
// with it the two published advisories that have no upstream fix at all
// (`elliptic`'s risky primitive and `lodash`'s `_.template` injection). Naming
// the two plugins directly is what makes `npm audit` reachable at zero.
import "@nomicfoundation/hardhat-viem";
import "@nomicfoundation/hardhat-network-helpers";

// The toolbox also did this. `.to.be.rejected` in the contract tests needs it.
chai.use(chaiAsPromised);

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // TesseraPool's multi-return views need the IR pipeline (stack too deep otherwise).
      viaIR: true,
    },
  },
  networks: {
    arcTestnet: {
      url: ARC_RPC_URL,
      chainId: 5042002,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
