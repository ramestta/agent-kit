const { ethers } = require("hardhat");
const fs = require("fs");
async function main(){
  const [d] = await ethers.getSigners();
  const gp = { gasPrice: ethers.parseUnits("7","gwei") };
  console.log("Deployer:", d.address);
  const reg = await (await ethers.getContractFactory("KeeperRegistry")).deploy(gp);
  await reg.waitForDeployment();
  const addr = await reg.getAddress();
  console.log("KeeperRegistry:", addr);
  console.log("tx:", "https://ramascan.com/tx/"+reg.deploymentTransaction().hash);
  fs.writeFileSync("deployments.keeper-registry-mainnet.json", JSON.stringify({
    network:"ramesttaMainnet", chainId:1370, KeeperRegistry:addr, deployedAt:new Date().toISOString()
  },null,2));
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1)});
