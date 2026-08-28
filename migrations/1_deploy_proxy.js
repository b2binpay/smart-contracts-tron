const ProxyFactory = artifacts.require("ProxyFactory");

module.exports = (deployer) => {
  deployer.deploy(ProxyFactory);
};
