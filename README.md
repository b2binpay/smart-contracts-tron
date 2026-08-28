# Overview

**B2BinPay** smart contracts for the TRON network — deposit accounts, factories and the
multi-signature wallet, compiled for the TVM with TronBox.

This branch deploys `MultiSigWallet` **1.3.0**, which replaces the claim whitelist with a packed
permission model and adds the TRON delegation permissions on top of it. The base contracts come from
[b2binpay/smart-contracts](https://github.com/b2binpay/smart-contracts) — audit reports for the
earlier versions live in `docs/audit/` there, and 1.3.0 is the revision going to audit, on both
chains. Everything TVM-specific is confined to the `istanbul/` overlay and `0.8.25/contracts/tvm/`
described below.

## Prerequisites

- Node.js v24 (`^24.16.0`)
- npm v11
- Docker (for local TRON node)

```bash
$ npm install
$ cp .env.blank .env
```

The compiled source tree `0.8.25/contracts` is committed, so a fresh clone goes straight to
[Compile](#compile) and [Deploy](#deploy) — populate `.env` and run the npm scripts.

Re-sync from the EVM repository only when its contracts change. It copies `../evm/contracts` in and
re-applies the `istanbul/` overlay on top, so a checkout of
[b2binpay/smart-contracts](https://github.com/b2binpay/smart-contracts) must sit next to this one at
`../evm`, on the intended revision:

```bash
npm run copy-contracts
npm run patch-contracts
```

`patch-contracts` rebuilds `0.8.25/contracts` from scratch, so a source renamed or removed upstream
shows up as a deletion instead of lingering as a stale file. It refuses to run without `contracts/`,
leaving the existing tree untouched.

Review `git diff 0.8.25/` afterwards — the overlay result is what gets compiled and deployed.

## Patch Structure

- `istanbul/` - Modified contracts for Istanbul EVM target (TVM compatibility)
  - Contains patched versions of contracts that require TVM-specific adjustments
  - `proxy/Clones.sol` - Modified to use `0x41` prefix instead of `0xFF` for TVM
  - `utils/Bytes.sol` - Modified to use manual copy loop instead of `mcopy` opcode
  - `utils/Create2.sol` - Modified to use `0x41` prefix instead of `0xFF` for TVM
  - `token/ERC20/utils/SafeERC20Minimal.sol` - Modified to ignore the `transfer` returndata:
    TRON USDT returns `false` from a successful `transfer`, which the EVM version rejects
  - `Migrations.sol` - TronBox contract for migration/deployment
  - `mocks/TetherToken.sol`, `mocks/ERC20ReturnDataMock.sol` - Test fixtures behind the mock USDT
    migration and `demo:usdt`; kept here so `copy-contracts` + `patch-contracts` reproduces them
    from a clean tree instead of relying on what the EVM checkout happens to carry
  - An overlay either replaces the EVM-sourced file at the same path — then it must be moved
    whenever that path changes upstream — or adds a TVM-only source the EVM repository has no
    copy of
- `0.8.25/contracts/tvm/` — TVM-only extensions that build on the EVM-aligned base
  - `MultiSigWalletStaking.sol` (contract `MultiSigWalletStaking`) extends
    `MultiSigWallet` with TRON Stake 2.0 (freeze / unfreeze / cancel / withdraw),
    resource delegation (delegate / undelegate) and Super Representative voting
    (`voteWitnesses` / `withdrawReward` / `pendingReward`). This is the contract
    deployed as the proxy-factory implementation on TRON. `version()` is inherited from the base
    `MultiSigWallet` and returns `1.3.0` on both chains: the string identifies the permission encoding
    and the EIP-712 domain, both unchanged from the base here, so a TVM-only digit would announce a
    difference that does not exist. The ABI is not part of that promise: the full surface differs
    between the chains and is resolved per `(version, networkType[, networkId])`. The permission set is
    a separate question with a direct answer — `supportedPermissions()` reads it off the deployment,
    which works before that version is registered anywhere
  - `delegateResource` / `undelegateResource` are gated by
    `onlyFactoryOrPermitted(PERMISSION_DELEGATE / PERMISSION_UNDELEGATE)`: the multisig queue reaches
    them through `execute()`, and so does an address the multisig granted the matching permission —
    owner status alone does not. Every other entry point here stays `onlyFactory`
  - `PERMISSION_DELEGATE` (bit 128) and `PERMISSION_UNDELEGATE` (bit 129) are declared here, above the
    base range `BASE_PERMISSION_MASK`, and returned from `_extensionPermissions()`. The base composes
    them onto `PERMISSION_CLAIM` in the non-virtual `supportedPermissions()`, so a mask on TRON may
    hold all three while the EVM base enforces claim alone and rejects a delegation bit.
    `setup()` refuses to initialize a clone whose extension permissions reach into the base range
  - The base file `0.8.25/contracts/MultiSigWallet.sol` stays aligned with the EVM source except for
    the target Solidity pragma, which `patch-contracts.js` rewrites, and the explicit Istanbul
    overlays listed above. Nothing else in a copied source is edited on the way through, so a TVM-only
    behaviour has to live in an overlay where `git diff` shows it.

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

`DEPLOYER_PRIVATE_KEY` is the account that pays and owns the deployment — leaving the `.env.blank`
placeholder deploys from the local-node demo account, which holds nothing on a public network. A
full Shasta run (`0` … `3`) costs roughly 20 TRX. Always deploy through the npm scripts: they
source `.env`, and `SOLC_TARGET` selects both the contracts directory and the build directory, so a
bare `npx tronbox migrate` reads the wrong paths and reports missing artifacts.

```bash
# Deploy on the `Mainnet`
$ npm run migrate:mainnet
```

```bash
# Deploy on the `Shasta` testnet
$ npm run migrate:shasta
```

A run without `--f` / `--to` walks the whole chain, so on a local node and on testnets it also
deploys the mock USDT. On the mainnet that migration is skipped, and the run ends with the
`MultiSigWalletStaking` implementation.

| #   | Migration                              | Mainnet  |
|-----|----------------------------------------|----------|
| 0   | `Migrations` — TronBox bookkeeping      | deployed |
| 1   | `ProxyFactory`                          | deployed |
| 2   | `MultiSigWalletStaking` implementation  | deployed |
| 3   | `TetherToken` — mock USDT               | skipped  |

Single migrations are deployed with `--f` / `--to`:

```bash
# Only the MultiSigWallet implementation
$ npm run migrate:shasta:multisig

# Only the mock USDT
$ npm run migrate:usdt         # local TRON node
$ npm run migrate:shasta:usdt  # Shasta testnet
```

### Mock USDT

`TetherToken` is a port of the mainnet TRON USDT contract: its `transfer` moves the funds and
returns `false`. Migration `3_deploy_tether_mock.js` deploys it for QA and integration tests —
see `migrate:usdt` / `migrate:shasta:usdt` above.

It is deployed as `Tether USD (Mock)` / `USDTM`, so wallets and explorers never show it as real
USDT, while the parameters that reproduce the bug — 6 decimals and the dormant fee mechanism —
stay mainnet-faithful.

The whole supply (1 000 000 USDTM) lands on the deployer, who hands it out with `transfer` and
mints more with `issue`. On a local node TronBox deploys from the node's own account, so the
supply lands there rather than on `DEPLOYER_PRIVATE_KEY`; the migration reports the holder it
read from the contract. Before the migration completes it verifies the deployed instance:
mainnet parameters, dormant fee mechanism, and a simulated `transfer` that decodes to `false`.

### Demo

Run the full *MultiSigWallet* demo on a local TRON node:

```bash
# Deposit sweep and the EIP-712 multisig flow
$ npm run demo

# The same claim path against the mock USDT, which returns `false` from a successful transfer
$ npm run demo:usdt
```

Assertion-driven runs of the staking extension, each verified by the stake it moves. The extras run
needs a wallet left behind by the first one:

```bash
$ npm run test:staking
$ npm run test:staking:extras
```

## Verification

Flatten contracts into single files for on-chain verification on [TronScan](https://tronscan.org/).

```bash
$ npm run flatten
```

Output: `build/{SOLC_TARGET}/flattened/*.sol`

| Contract              | Flattened file                  |
|-----------------------|---------------------------------|
| MultiSigWalletStaking | `tvm/MultiSigWalletStaking.sol` |
| MultiSigWallet        | `MultiSigWallet.sol`            |
| ProxyFactory          | `ProxyFactory.sol`              |
| DepositAccount        | `DepositAccount.sol`            |
| FactoryA              | `FactoryA.sol`                  |
| FactoryB              | `FactoryB.sol`                  |

Upload the flattened `.sol` file to TronScan → **Verify Contract** with the following settings:

| Parameter    | Value      |
|--------------|------------|
| Compiler     | `0.8.25`   |
| EVM Version  | `istanbul` |
| Optimization | Yes        |
| Runs         | `200`      |

## Clean

```bash
# Remove build artifacts and the EVM contracts copy
npm run clean
```

`clean` keeps the committed `0.8.25/contracts` tree — only `build/` and the `contracts/` copy that
`copy-contracts` creates are removed, so `npm run compile` works right after it.
