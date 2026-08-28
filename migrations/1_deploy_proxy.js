const ProxyFactory = artifacts.require("./ProxyFactory.sol");

module.exports = (deployer) => {
  deployer.deploy(ProxyFactory);
};
