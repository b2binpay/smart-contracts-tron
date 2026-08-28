const path = require("path")

const SOLC_TARGET = process.env.SOLC_TARGET || '0.8.25';

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY !== undefined 
  ? process.env.DEPLOYER_PRIVATE_KEY 
  : '0000000000000000000000000000000000000000000000000000000000000001'; // For tronbox/tre docker image default account 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf [TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC]

module.exports = {
  contracts_directory: path.resolve(__dirname, SOLC_TARGET, 'contracts'),
  contracts_build_directory: path.resolve(__dirname, 'build', SOLC_TARGET, 'contracts'),

  compilers: {
    solc: {
      version: SOLC_TARGET,
      // An object with the same schema as the settings entry in the Input JSON.
      // See https://docs.soliditylang.org/en/latest/using-the-compiler.html#input-description
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        },
        evmVersion: 'istanbul',
      }
    }
  },

  networks: {
    mainnet: {
      // Don't put your private key here:
      privateKey: PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://api.trongrid.io',
      network_id: '1',
      consume_user_resource_percent: 100,
    },
    shasta: {
      privateKey: PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://api.shasta.trongrid.io',
      network_id: '2',
      consume_user_resource_percent: 100,
    },
    nile: {
      privateKey: PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://api.nileex.io',
      network_id: '3',
      consume_user_resource_percent: 100,
    },
    development: {
      privateKey: PRIVATE_KEY,
      userFeePercentage: 0,
      feeLimit: 1000 * 1e6,
      fullHost: 'http://127.0.0.1:9090',
      network_id: '9',
      consume_user_resource_percent: 100,
    },
  }
}
