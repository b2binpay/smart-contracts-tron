# Overview

**B2BinPay** smart contracts for the TRON network — deposit accounts, factories and the
multi-signature wallet, compiled for the TVM with [TronBox](https://developers.tron.network/docs/tronbox-vs-truffle).

The sources are the EVM contracts from
[b2binpay/smart-contracts](https://github.com/b2binpay/smart-contracts), compiled against the
`istanbul` EVM target with a TVM overlay on top (`0x41` CREATE2 prefix, no `mcopy`) plus the
TRON-only staking and resource-delegation extension.
