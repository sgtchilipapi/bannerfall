import { configVariable, defineConfig } from "hardhat/config";
import hardhatKeystore from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";


export default defineConfig({
  solidity: {
    version: "0.8.28",
    isolated: true,
  },
  networks: {
    fuji: {
      type: "http",
      chainType: "l1",
      url: "https://api.avax-test.network/ext/bc/C/rpc",
      accounts: [configVariable("FUJI_PVK_1")],
    },
  },
  plugins: [hardhatKeystore, hardhatToolboxMochaEthers],
});
