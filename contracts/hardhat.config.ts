import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
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
