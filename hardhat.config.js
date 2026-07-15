require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

// Deployer key comes from .env (never commit). Testnet key is funded via
// https://testnet-faucet.ramascan.com — 10 RAMA per claim.
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

// Mainnet deploys (incl. the hardhat-upgrades plugin, which uses the network's
// default signer) run from the prod deployer. Key is read from the gitignored
// prod-deployer.json — never printed, never committed.
const fs = require("fs");
let mainnetAccounts = accounts;
try {
  const pd = JSON.parse(fs.readFileSync(__dirname + "/prod-deployer.json", "utf8"));
  const k = pd.privateKey || pd.key || pd.pk;
  if (k) mainnetAccounts = [k];
} catch (_) {}

module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      // Mirrors the settings the live mainnet contracts were built with
      // (foundry.toml on server 116: via_ir=true, optimizer_runs=1, evm=paris)
      viaIR: true,
      optimizer: { enabled: true, runs: 1 },
      evmVersion: "paris",
    },
  },
  networks: {
    ramesttaTestnet: {
      url: "https://testnet.ramestta.com",
      chainId: 1371,
      accounts,
    },
    ramesttaMainnet: {
      url: "https://blockchain.ramestta.com",
      chainId: 1370,
      accounts: mainnetAccounts,
    },
  },
  // RamaScan is Blockscout — the API key value is ignored, any string works.
  etherscan: {
    apiKey: { ramesttaMainnet: "ramascan" },
    customChains: [
      {
        network: "ramesttaMainnet",
        chainId: 1370,
        urls: {
          apiURL: "https://latest-backendapi.ramascan.com/api/",
          browserURL: "https://ramascan.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
