const MultiSigWalletStaking = artifacts.require("MultiSigWalletStaking");

module.exports = (deployer) => {
  deployer.deploy(MultiSigWalletStaking);
};
