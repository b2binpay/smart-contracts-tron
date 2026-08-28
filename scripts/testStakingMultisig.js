/**
 * Multisig Stake 2.0 + Resource Delegation flow test.
 *
 * Deploys ProxyFactory + MultiSigWallet implementation, creates a 1-of-1 wallet,
 * funds it, and exercises every staking/delegation entry point through the
 * EIP-712 multisig `execute()` path. Each operation is verified by the stake it
 * moves, which holds on a local node and on a public network alike.
 */
const { TronWeb } = require("tronweb");
const { Wallet, TypedDataEncoder, recoverAddress, keccak256, getBytes } = require("ethers");

const fs = require("node:fs");
const path = require("node:path");

const { TRON_FEE_LIMIT } = require("./utils/constants");

const SOLC_TARGET = process.env.SOLC_TARGET || "0.8.25";
const PROVIDER_URI = process.env.PROVIDER_URI || "https://api.shasta.trongrid.io";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(__dirname, `../build/${SOLC_TARGET}/contracts`);

const SUN_PER_TRX = 1_000_000n;
const RES_BANDWIDTH = 0;
const RES_ENERGY = 1;

const FUND_TRX = 1100n;
const STAKE_ENERGY_TRX = 400n;
const STAKE_BANDWIDTH_TRX = 200n;
const DELEGATE_ENERGY_TRX = 200n;
const UNFREEZE_AMOUNT_TRX = 100n;

const WALLET_ID = `0x${"00".repeat(31)}07`;
const ZERO_ID = `0x${"00".repeat(32)}`;

if (!PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY env not set");
}

const tronWeb = new TronWeb(PROVIDER_URI, PROVIDER_URI, PROVIDER_URI, PRIVATE_KEY);

function readArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, `${name}.json`), "utf8"));
}

function sleep(ms = 4000) {
  return new Promise((r) => setTimeout(r, ms));
}

function strip0x(h) {
  return h.startsWith("0x") ? h.slice(2) : h;
}

function toHex20(addr) {
  if (Array.isArray(addr)) {
    return addr.map(toHex20);
  }
  if (!addr) {
    return addr;
  }
  let h = addr.startsWith("T") ? tronWeb.address.toHex(addr) : addr;
  if (h.startsWith("0x")) {
    h = h.slice(2);
  }
  if (h.startsWith("41") && h.length === 42) {
    h = h.slice(2);
  }
  return `0x${h.padStart(40, "0")}`.toLowerCase();
}

function toHex41(addr) {
  if (!addr) {
    return addr;
  }
  if (addr.startsWith("T")) {
    return tronWeb.address.toHex(addr);
  }
  const h = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (h.length === 40) {
    return `41${h}`;
  }
  return h;
}

function toB58(addrHex) {
  return tronWeb.address.fromHex(addrHex.startsWith("0x") ? `41${addrHex.slice(2)}` : addrHex);
}

/** `expectFail` inverts the outcome the wait accepts: a call that must be refused proves nothing by going through. */
async function waitTxInfo(txId, expectFail = false, timeoutMs = 360000, intervalMs = 4000) {
  const id = typeof txId === "string" ? txId : txId?.txID || txId?.txid || txId?.id;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await tronWeb.trx.getTransactionInfo(id);
    if (info?.id) {
      const result = info.receipt?.result;
      const failed = result === "REVERT" || result === "FAILED" || info.result === "FAILED";
      if (failed && !expectFail) {
        throw new Error(`tx ${id} failed: ${JSON.stringify(info)}`);
      }
      if (!failed && expectFail) {
        throw new Error(`tx ${id} was accepted, expected a revert`);
      }
      // Contract calls have receipt.result === SUCCESS; native TRX transfers have no result field but populate info.id
      if (failed || result === "SUCCESS" || !result) {
        return info;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`tx ${id} not confirmed within ${timeoutMs}ms`);
}

/**
 * Prints the account's resource line and returns the stake it holds itself, in sun — what every
 * staking entry point below moves.
 *
 * The gates read the returned stake and not the printed `EnergyLimit`: that limit is the account's
 * share of a network-wide pool fixed at `TotalEnergyLimit`, so it moves whenever anybody else
 * stakes, and on a node with a single staker it stays pinned at the whole pool no matter how much
 * the account unfreezes. The printed line is context for reading the log, never a gate.
 */
async function snapshot(label, base58) {
  const [resources, account] = await Promise.all([
    tronWeb.trx.getAccountResources(base58),
    tronWeb.trx.getAccount(base58),
  ]);
  const energyLimit = resources.EnergyLimit || 0;
  const netLimit = resources.NetLimit || 0;
  const balanceTrx = TronWeb.fromSun((account.balance || 0).toString()).toString();
  console.log(
    `  | ${label.padEnd(14)} | TRX ${balanceTrx.padStart(10)} | Energy: ${energyLimit
      .toString()
      .padStart(8)} | Net: ${netLimit.toString().padStart(7)} | TP: ${resources.tronPowerLimit || 0}`,
  );

  const frozen = account.frozenV2 || [];
  const resource = account.account_resource || {};
  const bandwidthEntry = frozen.find((entry) => !entry.type);
  const energyEntry = frozen.find((entry) => entry.type === "ENERGY");

  return {
    frozenEnergy: BigInt(energyEntry?.amount || 0),
    frozenBandwidth: BigInt(bandwidthEntry?.amount || 0),
    delegatedEnergy: BigInt(resource.delegated_frozenV2_balance_for_energy || 0),
    acquiredEnergy: BigInt(resource.acquired_delegated_frozenV2_balance_for_energy || 0),
    pendingUnfreeze: (account.unfrozenV2 || []).reduce(
      (total, entry) => total + BigInt(entry.unfreeze_amount || 0),
      0n,
    ),
  };
}

function encodeSetup(owners0x41, threshold) {
  const iface = new (require("ethers").Interface)(["function setup(address[] owners_, uint256 threshold_)"]);
  const owners20 = owners0x41.map((a) => toHex20(a));
  return iface.encodeFunctionData("setup", [owners20, threshold]);
}

function encodeFunction(signature, params) {
  const fragment = require("ethers").FunctionFragment.from(signature);
  const iface = new (require("ethers").Interface)([fragment]);
  return iface.encodeFunctionData(fragment.name, params);
}

async function signExecuteCalls(walletHex41, calls, nonceOpt, abi, pk) {
  const w = await tronWeb.contract(abi, toB58(walletHex41));
  const d = await w.eip712Domain().call();
  const name = (d.name || d[1] || "MultiSigWallet").toString();
  const version = (d.version || d[2] || "1.0.0").toString();
  const chainId = BigInt(d.chainId || d[3]);
  const verifyingContract = toHex20(walletHex41);

  const normalizedCalls = calls.map((c) => ({
    to: toHex20(c.to),
    value: BigInt(c.value),
    data: c.data,
  }));
  const nonce = BigInt(nonceOpt ?? (await w.nonce().call()));

  const domain = { name, version, chainId, verifyingContract };
  const types = {
    Call: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    Execute: [
      { name: "calls", type: "Call[]" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const message = { calls: normalizedCalls, nonce };
  const signer = new Wallet(pk);
  const signature = await signer.signTypedData(domain, types, message);
  const digest = TypedDataEncoder.hash(domain, types, message);
  return { digest, signature };
}

function packSignatures(digest, sigs) {
  const items = sigs.map((s) => ({
    signer: recoverAddress(digest, s).toLowerCase(),
    signature: s,
  }));
  items.sort((a, b) => a.signer.localeCompare(b.signer));
  const parts = items.map(({ signer, signature }) => {
    const signerHex = strip0x(signer);
    const sigHex = strip0x(signature);
    const sigLen = sigHex.length / 2;
    const sigLenHex = sigLen.toString(16).padStart(4, "0");
    return `${signerHex}${sigLenHex}${sigHex}`;
  });
  return `0x${parts.join("")}`;
}

async function executeOps(walletContract, calls, signature, id = ZERO_ID) {
  const tupleCalls = calls.map((c) => [toHex41(c.to), BigInt(c.value).toString(), c.data]);
  const tupleOps = [[tupleCalls, signature, id]];
  return walletContract.execute(tupleOps).send({ feeLimit: TRON_FEE_LIMIT });
}

async function execAsOwner(walletContract, walletHex, abi, pk, calls, label) {
  console.log(`\n┏ ${label}`);
  const { digest, signature } = await signExecuteCalls(walletHex, calls, null, abi, pk);
  const packed = packSignatures(digest, [signature]);
  const tx = await executeOps(walletContract, calls, packed);
  const info = await waitTxInfo(tx);
  console.log(`┗ tx: ${tx} (energy ${info.receipt?.energy_usage_total || 0})`);
  return info;
}

async function main() {
  const deployerB58 = tronWeb.defaultAddress.base58;
  const deployerHex = tronWeb.defaultAddress.hex;
  const deployerBalance = await tronWeb.trx.getBalance(deployerB58);
  console.log(`╭ Deployer : ${deployerB58} (${TronWeb.fromSun(deployerBalance)} TRX)`);
  console.log(`| Provider : ${PROVIDER_URI}`);
  console.log(`╰ Solc     : ${SOLC_TARGET}`);

  const minTrx = (FUND_TRX + 200n) * SUN_PER_TRX;
  if (BigInt(deployerBalance) < minTrx) {
    throw new Error(
      `Deployer balance too low: need ~${FUND_TRX + 200n} TRX, have ${TronWeb.fromSun(deployerBalance)} TRX`,
    );
  }

  const ProxyFactory = readArtifact("ProxyFactory");
  const MultiSigWallet = readArtifact("MultiSigWalletStaking");

  // Single-owner wallet: deployer signs everything.
  const ownerPk = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const ownerEoa = new Wallet(ownerPk).address.toLowerCase();
  const ownersHex41 = [toHex41(ownerEoa)];
  const threshold = 1;

  let proxy;
  let impl;
  let walletHex41;

  if (process.env.WALLET_ADDR) {
    console.log("\n┏ Reuse deployed wallet");
    walletHex41 = toHex41(process.env.WALLET_ADDR).toLowerCase();
    if (!walletHex41.startsWith("41")) {
      walletHex41 = `41${walletHex41}`;
    }
    walletHex41 = walletHex41.toLowerCase();
    console.log(`┗ ${process.env.WALLET_ADDR}`);
  } else {
    console.log("\n┏ Deploy ProxyFactory");
    proxy = await tronWeb.contract().new({
      abi: ProxyFactory.abi,
      bytecode: ProxyFactory.bytecode,
      feeLimit: TRON_FEE_LIMIT,
      callValue: 0,
      parameters: [],
    });
    console.log(`┗ ${toB58(proxy.address)}`);
    await sleep();

    console.log("\n┏ Deploy MultiSigWallet implementation");
    impl = await tronWeb.contract().new({
      abi: MultiSigWallet.abi,
      bytecode: MultiSigWallet.bytecode,
      feeLimit: TRON_FEE_LIMIT,
      callValue: 0,
      parameters: [],
    });
    console.log(`┗ ${toB58(impl.address)}`);
    await sleep();

    console.log(`\n┏ createInstance(impl, setup(${ownersHex41}, ${threshold}), id=${WALLET_ID})`);
    const initializer = encodeSetup(ownersHex41, threshold);
    const createTx = await proxy
      .createInstance(impl.address, initializer, WALLET_ID)
      .send({ feeLimit: TRON_FEE_LIMIT });
    await waitTxInfo(createTx);

    const computeRet = await proxy.computeAddress(impl.address, initializer, WALLET_ID).call();
    walletHex41 = (computeRet.instance || computeRet["1"] || computeRet[1]).toLowerCase();
  }
  const walletB58 = toB58(walletHex41);
  console.log(`┗ wallet: ${walletB58} (${walletHex41})`);

  const wallet = await tronWeb.contract(MultiSigWallet.abi, walletB58);
  console.log(`  | version: ${await wallet.version().call()}`);
  console.log(`  | threshold: ${(await wallet.threshold().call()).toString()}`);
  console.log(`  | owners: ${await wallet.owners().call()}`);
  await sleep();

  const currentBal = BigInt(await tronWeb.trx.getBalance(walletB58));
  if (currentBal < FUND_TRX * SUN_PER_TRX) {
    const need = FUND_TRX * SUN_PER_TRX - currentBal;
    console.log(
      `\n┏ Fund wallet with ${TronWeb.fromSun(need.toString())} TRX (have ${TronWeb.fromSun(currentBal.toString())})`,
    );
    const fundTx = await tronWeb.trx.sendTrx(walletB58, Number(need));
    await waitTxInfo(fundTx.txid || fundTx.transaction.txID);
    console.log(`┗ wallet balance: ${TronWeb.fromSun(await tronWeb.trx.getBalance(walletB58))} TRX`);
    await sleep();
  } else {
    console.log(`\n| Wallet already funded: ${TronWeb.fromSun(currentBal.toString())} TRX`);
  }

  console.log("\n| Resources INITIAL |");
  const s0 = await snapshot("wallet", walletB58);
  const s0d = await snapshot("deployer", deployerB58);

  // Test 1: freeze for ENERGY
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("freezeBalanceV2(uint256,uint256)", [
          (STAKE_ENERGY_TRX * SUN_PER_TRX).toString(),
          RES_ENERGY,
        ]),
      },
    ],
    `freezeBalanceV2(${STAKE_ENERGY_TRX} TRX, ENERGY)`,
  );
  await sleep();
  const s1 = await snapshot("wallet", walletB58);
  const energyStake = STAKE_ENERGY_TRX * SUN_PER_TRX;
  const energyStaked = s1.frozenEnergy - s0.frozenEnergy;
  if (energyStaked !== energyStake) {
    throw new Error(`ENERGY stake grew by ${energyStaked} sun, expected ${energyStake}`);
  }
  console.log(`✅ ENERGY staked +${STAKE_ENERGY_TRX} TRX`);

  // Test 2: freeze for BANDWIDTH
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("freezeBalanceV2(uint256,uint256)", [
          (STAKE_BANDWIDTH_TRX * SUN_PER_TRX).toString(),
          RES_BANDWIDTH,
        ]),
      },
    ],
    `freezeBalanceV2(${STAKE_BANDWIDTH_TRX} TRX, BANDWIDTH)`,
  );
  await sleep();
  const s2 = await snapshot("wallet", walletB58);
  const bandwidthStake = STAKE_BANDWIDTH_TRX * SUN_PER_TRX;
  const bandwidthStaked = s2.frozenBandwidth - s1.frozenBandwidth;
  if (bandwidthStaked !== bandwidthStake) {
    throw new Error(`BANDWIDTH stake grew by ${bandwidthStaked} sun, expected ${bandwidthStake}`);
  }
  console.log(`✅ BANDWIDTH staked +${STAKE_BANDWIDTH_TRX} TRX`);

  // Test 3: delegateResource(ENERGY) to deployer
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("delegateResource(uint256,address,uint256)", [
          (DELEGATE_ENERGY_TRX * SUN_PER_TRX).toString(),
          toHex20(deployerHex),
          RES_ENERGY,
        ]),
      },
    ],
    `delegateResource(${DELEGATE_ENERGY_TRX} TRX, deployer, ENERGY)`,
  );
  await sleep();
  const s3 = await snapshot("wallet", walletB58);
  const s3d = await snapshot("deployer", deployerB58);
  const delegatedEnergy = DELEGATE_ENERGY_TRX * SUN_PER_TRX;
  const walletDelegated = s3.delegatedEnergy - s2.delegatedEnergy;
  const deployerAcquired = s3d.acquiredEnergy - s0d.acquiredEnergy;
  if (walletDelegated !== delegatedEnergy) {
    throw new Error(`wallet delegated ${walletDelegated} sun of ENERGY, expected ${delegatedEnergy}`);
  }
  if (deployerAcquired !== delegatedEnergy) {
    throw new Error(`deployer acquired ${deployerAcquired} sun of ENERGY, expected ${delegatedEnergy}`);
  }
  console.log(`✅ Delegated ENERGY: wallet -${DELEGATE_ENERGY_TRX} TRX, deployer +${DELEGATE_ENERGY_TRX} TRX`);

  // Test 4: undelegateResource (reclaim)
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("undelegateResource(uint256,address,uint256)", [
          (DELEGATE_ENERGY_TRX * SUN_PER_TRX).toString(),
          toHex20(deployerHex),
          RES_ENERGY,
        ]),
      },
    ],
    `undelegateResource(${DELEGATE_ENERGY_TRX} TRX, deployer, ENERGY)`,
  );
  await sleep();
  const s4 = await snapshot("wallet", walletB58);
  const s4d = await snapshot("deployer", deployerB58);
  if (s4.delegatedEnergy !== s2.delegatedEnergy) {
    throw new Error(`wallet still delegates ${s4.delegatedEnergy} sun of ENERGY, expected ${s2.delegatedEnergy}`);
  }
  if (s4d.acquiredEnergy !== s0d.acquiredEnergy) {
    throw new Error(
      `deployer still holds ${s4d.acquiredEnergy} sun of acquired ENERGY, expected ${s0d.acquiredEnergy}`,
    );
  }
  console.log("✅ Reclaimed ENERGY: the delegation is gone from both accounts");

  // Test 5: unfreeze 100 TRX of ENERGY
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("unfreezeBalanceV2(uint256,uint256)", [
          (UNFREEZE_AMOUNT_TRX * SUN_PER_TRX).toString(),
          RES_ENERGY,
        ]),
      },
    ],
    `unfreezeBalanceV2(${UNFREEZE_AMOUNT_TRX} TRX, ENERGY)`,
  );
  await sleep();
  const s5 = await snapshot("wallet", walletB58);
  const unfrozen = UNFREEZE_AMOUNT_TRX * SUN_PER_TRX;
  const stakeShrank = s4.frozenEnergy - s5.frozenEnergy;
  const nowPending = s5.pendingUnfreeze - s4.pendingUnfreeze;
  if (stakeShrank !== unfrozen) {
    throw new Error(`ENERGY stake shrank by ${stakeShrank} sun, expected ${unfrozen}`);
  }
  if (nowPending !== unfrozen) {
    throw new Error(`${nowPending} sun is pending withdrawal, expected ${unfrozen}`);
  }
  console.log(`✅ Unfreeze initiated: ${UNFREEZE_AMOUNT_TRX} TRX left the stake and waits out the delay`);

  // Test 6: cancelAllUnfreezeV2 — re-stake pending unfreeze
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("cancelAllUnfreezeV2()", []),
      },
    ],
    "cancelAllUnfreezeV2()",
  );
  await sleep();
  const s6 = await snapshot("wallet", walletB58);
  if (s6.pendingUnfreeze !== 0n) {
    throw new Error(`${s6.pendingUnfreeze} sun is still pending withdrawal after the cancel`);
  }
  if (s6.frozenEnergy !== s4.frozenEnergy) {
    throw new Error(`ENERGY stake is ${s6.frozenEnergy} sun after the cancel, expected ${s4.frozenEnergy} restaked`);
  }
  console.log(`✅ Cancel: the pending ${UNFREEZE_AMOUNT_TRX} TRX went back into the ENERGY stake`);

  // Test 7: withdrawExpireUnfreeze (returns 0 since nothing matured yet — still callable)
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("withdrawExpireUnfreeze()", []),
      },
    ],
    "withdrawExpireUnfreeze() [expects 0 — no matured unfreeze]",
  );
  console.log("✅ withdrawExpireUnfreeze callable via multisig");

  // Test 8: direct call from EOA must revert (onlyFactory)
  console.log("\n┏ Direct freezeBalanceV2 from EOA (should revert)");
  let directTx;
  try {
    directTx = await wallet
      .freezeBalanceV2((1n * SUN_PER_TRX).toString(), RES_ENERGY)
      .send({ feeLimit: TRON_FEE_LIMIT });
  } catch (e) {
    // A rejection before the broadcast proves nothing about the on-chain gate — the caller's key, the
    // ABI or the node would fail the same way — so it is reported as a failure of the test itself.
    throw new Error(`direct freezeBalanceV2 never reached the chain: ${(e?.message || e).toString().slice(0, 200)}`);
  }
  const directInfo = await waitTxInfo(directTx, true);
  console.log(`┗ ✅ on-chain ${directInfo.receipt?.result || directInfo.result}: ${directInfo.id}`);

  console.log("\n| Resources FINAL |");
  await snapshot("wallet", walletB58);
  await snapshot("deployer", deployerB58);

  console.log("\nAll multisig staking/delegation paths exercised successfully ✅");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
