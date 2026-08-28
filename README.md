# Overview

**B2BinPay** smart contracts for the TRON network — deposit accounts, factories and the
multi-signature wallet, compiled for the TVM with TronBox.

This release deploys `MultiSigWallet` **1.2.0**. The contracts are the EVM sources from
[b2binpay/smart-contracts](https://github.com/b2binpay/smart-contracts) compiled against the
`istanbul` EVM target, so the audit of the EVM 1.2.0 contracts covers the logic deployed here —
see [`docs/audit/certik_1_2_0.pdf`](https://github.com/b2binpay/smart-contracts/blob/main/docs/audit/certik_1_2_0.pdf)
in that repository. Only the `istanbul/` overlay below is TVM-specific.

## Prerequisites

- Node.js v18+
- npm
- Docker (for the local TRON node)

```bash
$ npm install
$ cp .env.blank .env
```

The compiled source tree `0.8.25/contracts` is committed, so a fresh clone goes straight to
[Compile](#compile) and [Deploy](#deploy).

Re-sync from the EVM repository only when its contracts change: `copy-contracts` reads a sibling
checkout of [b2binpay/smart-contracts](https://github.com/b2binpay/smart-contracts) at `../evm`, and
`patch-contracts` re-applies the `istanbul/` overlay on top.

```bash
# Copy contracts from the EVM repository if it's needed
npm run copy-contracts

npm run patch-contracts
```

## Patch Structure

- `istanbul/` - Modified contracts for Istanbul EVM target (TVM compatibility)
  - Contains patched versions of contracts that require TVM-specific adjustments
  - `proxy/Clones.sol` - Modified to use `0x41` prefix instead of `0xFF` for TVM
  - `utils/Bytes.sol` - Modified to use manual copy loop instead of `mcopy` opcode
  - `utils/Create2.sol` - Modified to use `0x41` prefix instead of `0xFF` for TVM
  - `Migrations.sol` - TronBox contract for migration/deployment

## Compile

```bash
$ npm run compile
```

## TronBox

```bash
# Pull the image using docker
docker pull tronbox/tre

# Run the container
docker run -it \
  -p 9090:9090 \
  --rm \
  --name tron \
  tronbox/tre

# Check node is running
curl -s -X POST http://127.0.0.1:9090/wallet/getnowblock -d '{}' | jq
```

*Note:* [amd64](https://hub.docker.com/layers/tronbox/tre/dev/images/sha256-e24e4dd6a3f72bac483a0af47553a5e075fd716371d0349a5fc25067b696f490) target.

## Deploy

Quick start:

```bash
# Local TRON node
$ npm run migrate
```

To deploy `ProxyFactory` & `MultiSigWallet` implementation (master copy) on the mainnet or testnets copy `.env.blank` to `.env` and populate values.

```bash
# Deploy on the `Mainnet`
$ npm run migrate:mainnet
```

```bash
# Deploy on the `Shasta` testnet
$ npm run migrate:shasta
```
### Demo

Run full *MultiSigWallet* demo on local TRON node:

```bash
$ npm run demo
```

## Verification

Flatten contracts into single files for on-chain verification on [TronScan](https://tronscan.org/).

```bash
$ npm run flatten
```

Output: `build/{SOLC_TARGET}/flattened/*.sol`

| Contract         | Flattened file       |
| ---------------- | -------------------- |
| MultiSigWallet   | `MultiSigWallet.sol` |
| ProxyFactory     | `ProxyFactory.sol`   |
| DepositAccount   | `DepositAccount.sol` |
| FactoryA         | `FactoryA.sol`       |
| FactoryB         | `FactoryB.sol`       |

Upload the flattened `.sol` file to TronScan → **Verify Contract** with the following settings:

| Parameter    | Value      |
| ------------ | ---------- |
| Compiler     | `0.8.25`   |
| EVM Version  | `istanbul` |
| Optimization | Yes        |
| Runs         | `200`      |

## Clean

```bash
# Remove build artifacts
npm run clean
```
