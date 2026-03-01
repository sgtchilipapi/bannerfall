import { network } from "hardhat";
const { ethers } = await network.connect();

async function main() {
  const contract = await ethers.deployContract("Bannerfall")
  await contract.waitForDeployment();

  console.log("Deployed to:", await contract.getAddress());
}

main();