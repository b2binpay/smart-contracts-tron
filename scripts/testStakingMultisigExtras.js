/**
 * Extra coverage on top of testStakingMultisig.js — runs against an existing wallet.
 *
 * - BANDWIDTH delegate / undelegate
 * - voteWitnesses + pendingReward + withdrawReward
 * - InvalidResourceType revert
 * - InvalidRecipient(0) revert for delegate / undelegate
 * - Direct EOA call to voteWitnesses (onlyFactory)
 * - Permissions: the supported set, its bit ranges and the published ABI surface, the signing
 *   domain, direct delegation from a permitted address, the owner-without-permission and
 *   wrong-permission reverts, an owner that the multisig granted the permission, claim isolated from
 *   the delegation permissions, argument validation on a direct permitted call, and an onlyFactory
 *   entry point staying closed to a permission holder
 *
 * Every negative case asserts the ABI-encoded error the contract returned, so a transaction that
 * fails for an unrelated reason — wrong key, wrong ABI, exhausted resources — fails the script
 * instead of passing as the expected rejection.
 *
 * Requires WALLET_ADDR pointing at a wallet that's already initialized + funded
 * + has at least ~200 TRX staked (so TronPower > 0 for voting).
 *
 * PERMITTED_PRIVATE_KEY is the account the permission tests call from. Without it the script
 * generates one and funds it from the deployer, which needs the deployer to hold the fee.
 */
const { TronWeb } = require("tronweb");
const { Wallet, TypedDataEncoder, recoverAddress, ErrorFragment, Interface, FunctionFragment } = require("ethers");

const fs = require("node:fs");
const path = require("node:path");

const {
  TRON_FEE_LIMIT,
  PERMISSION_CLAIM,
  BASE_PERMISSION_MASK,
  PERMISSION_DELEGATE,
  PERMISSION_UNDELEGATE,
  EXTENSION_PERMISSIONS,
  SUPPORTED_PERMISSIONS,
} = require("./utils/constants");

const SOLC_TARGET = process.env.SOLC_TARGET || "0.8.25";
const PROVIDER_URI = process.env.PROVIDER_URI || "https://api.shasta.trongrid.io";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(__dirname, `../build/${SOLC_TARGET}/contracts`);
const WALLET_ADDR = process.env.WALLET_ADDR;
const PERMITTED_PRIVATE_KEY = process.env.PERMITTED_PRIVATE_KEY;

const SUN_PER_TRX = 1_000_000n;
const RES_BANDWIDTH = 0;
const RES_ENERGY = 1;
const RES_UNKNOWN = 2;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_ID = `0x${"00".repeat(32)}`;

const DELEGATE_BW_TRX = 100n;
const VOTE_TP = 100n;

/**
 * The string registered per network and signed under as the EIP-712 domain version, so an overlay
 * bumped to anything else has to fail here rather than in someone's reading of the log.
 */
const EXPECTED_VERSION = "1.3.0";

// Fee budget for the direct calls the permitted account makes on its own
const PERMITTED_FUND_TRX = 200n;

const CLAIM_ID_PERMITTED = `0x${"00".repeat(31)}21`;
const CLAIM_ID_REVOKED = `0x${"00".repeat(31)}22`;

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
  if (!addr) return addr;
  let h = addr.startsWith("T") ? tronWeb.address.toHex(addr) : addr;
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.startsWith("41") && h.length === 42) h = h.slice(2);
  return `0x${h.padStart(40, "0")}`.toLowerCase();
}

function toHex41(addr) {
  if (!addr) return addr;
  if (addr.startsWith("T")) return tronWeb.address.toHex(addr);
  const h = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (h.length === 40) return `41${h}`;
  return h;
}

function toB58(addrHex) {
  return tronWeb.address.fromHex(addrHex.startsWith("0x") ? `41${addrHex.slice(2)}` : addrHex);
}

async function waitTxInfo(txId, expectFail = false, timeoutMs = 360000, intervalMs = 4000) {
  const id = typeof txId === "string" ? txId : txId?.txID || txId?.txid || txId?.id;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await tronWeb.trx.getTransactionInfo(id);
    if (info?.id) {
      const result = info.receipt?.result;
      const failed = result === "REVERT" || result === "FAILED" || info?.result === "FAILED";
      if (failed) {
        if (expectFail) {
          return { ok: false, info };
        }
        throw new Error(`tx ${id} failed: ${JSON.stringify(info).slice(0, 400)}`);
      }
      if (result === "SUCCESS" || !result) {
        if (expectFail) {
          throw new Error(`tx ${id} succeeded but expected revert`);
        }
        return { ok: true, info };
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`tx ${id} not confirmed within ${timeoutMs}ms`);
}

function encodeFunction(signature, params) {
  const fragment = FunctionFragment.from(signature);
  const iface = new Interface([fragment]);
  return iface.encodeFunctionData(fragment.name, params);
}

/**
 * The exact returndata a reverting call must carry, so a negative case is proven by the error the
 * contract raised and not by the transaction merely failing.
 */
function encodeError(signature, params) {
  const fragment = ErrorFragment.from(signature);
  const iface = new Interface([fragment]);
  return iface.encodeErrorResult(fragment, params).toLowerCase();
}

function unauthorized(addr) {
  return encodeError("UnauthorizedAccount(address)", [toHex20(addr)]);
}

function assertRevertPayload(info, expected, label) {
  const payload = info?.contractResult?.[0];
  if (!payload) {
    throw new Error(`${label}: reverted without returndata, cannot prove ${expected}`);
  }
  const actual = `0x${strip0x(payload)}`.toLowerCase();
  if (actual !== expected) {
    throw new Error(`${label}: reverted with ${actual}, expected ${expected}`);
  }
}

async function signExecuteCalls(walletHex41, calls, abi, pk) {
  const w = await tronWeb.contract(abi, toB58(walletHex41));
  const d = await w.eip712Domain().call();
  const name = (d.name || d[1]).toString();
  const version = (d.version || d[2]).toString();
  const chainId = BigInt(d.chainId || d[3]);
  const verifyingContract = toHex20(walletHex41);

  const normalizedCalls = calls.map((c) => ({
    to: toHex20(c.to),
    value: BigInt(c.value),
    data: c.data,
  }));
  const nonce = BigInt(await w.nonce().call());

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
  const signer = new Wallet(pk);
  const signature = await signer.signTypedData(domain, types, { calls: normalizedCalls, nonce });
  const digest = TypedDataEncoder.hash(domain, types, { calls: normalizedCalls, nonce });
  return { digest, signature };
}

function packSignatures(digest, sigs) {
  const items = sigs.map((s) => ({
    signer: recoverAddress(digest, s).toLowerCase(),
    signature: s,
  }));
  items.sort((a, b) => a.signer.localeCompare(b.signer));
  const parts = items.map(({ signer, signature }) => {
    const sigHex = strip0x(signature);
    const sigLen = sigHex.length / 2;
    return `${strip0x(signer)}${sigLen.toString(16).padStart(4, "0")}${sigHex}`;
  });
  return `0x${parts.join("")}`;
}

async function execAsOwner(walletContract, walletHex, abi, pk, calls, label, expectFail = false) {
  console.log(`\n┏ ${label}`);
  const { digest, signature } = await signExecuteCalls(walletHex, calls, abi, pk);
  const packed = packSignatures(digest, [signature]);
  const tupleCalls = calls.map((c) => [toHex41(c.to), BigInt(c.value).toString(), c.data]);
  const tx = await walletContract.execute([[tupleCalls, packed, ZERO_ID]]).send({ feeLimit: TRON_FEE_LIMIT });
  const { ok, info } = await waitTxInfo(tx, expectFail);
  console.log(`┗ tx: ${tx} ${ok ? "SUCCESS" : "REVERT"} (energy ${info.receipt?.energy_usage_total || 0})`);
  return info;
}

/**
 * `expectedRevert` is the ABI-encoded error the call must return, from `encodeError`. A rejection
 * before the broadcast proves nothing about the on-chain gate — the caller's key, the ABI or the
 * node would fail the same way — so it is reported as a failure of the test itself.
 */
async function sendDirect(contract, method, params, label, expectedRevert = null) {
  console.log(`\n┏ direct ${method}() — ${label}`);
  let tx;
  try {
    tx = await contract[method](...params).send({ feeLimit: TRON_FEE_LIMIT });
  } catch (e) {
    throw new Error(`direct ${method}() never reached the chain: ${(e?.message || e).toString().slice(0, 200)}`);
  }
  const { ok, info } = await waitTxInfo(tx, expectedRevert !== null);
  console.log(`┗ tx: ${tx} ${ok ? "SUCCESS" : "REVERT"} (energy ${info.receipt?.energy_usage_total || 0})`);
  if (expectedRevert) {
    assertRevertPayload(info, expectedRevert, `direct ${method}()`);
    console.log(`  returndata proves ${expectedRevert.slice(0, 10)}…`);
  }
  return info;
}

async function setPermissions(wallet, walletHex41, abi, ownerPk, accountHex, grants, revokes, label) {
  await execAsOwner(
    wallet,
    walletHex41,
    abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("updatePermissions(address[],uint256[],uint256[])", [
          [toHex20(accountHex)],
          [grants.toString()],
          [revokes.toString()],
        ]),
      },
    ],
    label,
  );

  const stored = BigInt(await wallet.permissionsOf(toHex20(accountHex)).call());
  console.log(`  permissionsOf(${toB58(toHex41(accountHex))}): ${stored}`);
  return stored;
}

// TronWeb takes the key unprefixed; a leading `0x` is rejected as invalid.
async function ensurePermittedAccount() {
  if (PERMITTED_PRIVATE_KEY) {
    const pk = strip0x(PERMITTED_PRIVATE_KEY);
    const b58 = tronWeb.address.fromPrivateKey(pk);
    console.log(`\n╭ Permitted account (from env): ${b58}`);
    return { pk, b58, hex: toHex41(b58) };
  }

  const account = await tronWeb.createAccount();
  const pk = account.privateKey.toLowerCase();
  const b58 = account.address.base58;
  console.log(`\n╭ Permitted account (generated): ${b58}`);

  const fundTx = await tronWeb.trx.sendTrx(b58, Number(PERMITTED_FUND_TRX * SUN_PER_TRX));
  await waitTxInfo(fundTx.txid || fundTx.transaction.txID);
  console.log(`╰ funded with ${PERMITTED_FUND_TRX} TRX for its own fees`);

  return { pk, b58, hex: toHex41(b58) };
}

async function fetchShastaSr() {
  const witnesses = await tronWeb.trx.listSuperRepresentatives();
  if (!witnesses?.length) {
    throw new Error("no SR list returned");
  }
  // pick first SR with 41-prefixed address
  for (const w of witnesses) {
    if (w.address && typeof w.address === "string") {
      const hex = w.address.toLowerCase();
      if (hex.startsWith("41") && hex.length === 42) {
        return hex;
      }
    }
  }
  throw new Error("no usable SR found");
}

async function printResources(label, base58) {
  const r = await tronWeb.trx.getAccountResources(base58);
  const bal = await tronWeb.trx.getBalance(base58);
  console.log(
    `  | ${label.padEnd(14)} | TRX ${TronWeb.fromSun(bal).toString().padStart(10)} | Energy: ${(r.EnergyLimit || 0)
      .toString()
      .padStart(8)} | Net: ${(r.NetLimit || 0).toString().padStart(7)} | TP: ${r.tronPowerLimit || 0}`,
  );
  return { energyLimit: r.EnergyLimit || 0, netLimit: r.NetLimit || 0, tp: r.tronPowerLimit || 0 };
}

async function ensureWallet(deployerHex, ownerPk) {
  const ProxyFactory = readArtifact("ProxyFactory");
  const MultiSigWallet = readArtifact("MultiSigWalletStaking");
  const ownerEoa = new Wallet(ownerPk).address.toLowerCase();
  const ownersHex41 = [toHex41(ownerEoa)];
  const threshold = 1;
  const walletId = `0x${"00".repeat(31)}11`;

  if (WALLET_ADDR) {
    const walletHex41 = toHex41(WALLET_ADDR).toLowerCase();
    return { walletHex41, walletB58: toB58(walletHex41), MultiSigWallet, deployedFresh: false };
  }

  console.log("\n┏ Deploy ProxyFactory");
  const proxy = await tronWeb.contract().new({
    abi: ProxyFactory.abi,
    bytecode: ProxyFactory.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [],
  });
  console.log(`┗ ${toB58(proxy.address)}`);
  await sleep();

  console.log("\n┏ Deploy MultiSigWallet implementation (with voting)");
  const impl = await tronWeb.contract().new({
    abi: MultiSigWallet.abi,
    bytecode: MultiSigWallet.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [],
  });
  console.log(`┗ ${toB58(impl.address)}`);
  await sleep();

  const setupIface = new Interface(["function setup(address[] owners_, uint256 threshold_)"]);
  const initializer = setupIface.encodeFunctionData("setup", [ownersHex41.map((a) => toHex20(a)), threshold]);

  console.log(`\n┏ createInstance(impl, setup, id=${walletId})`);
  const tx = await proxy.createInstance(impl.address, initializer, walletId).send({ feeLimit: TRON_FEE_LIMIT });
  await waitTxInfo(tx);

  const ret = await proxy.computeAddress(impl.address, initializer, walletId).call();
  const walletHex41 = (ret.instance || ret["1"] || ret[1]).toLowerCase();
  console.log(`┗ wallet: ${toB58(walletHex41)} (${walletHex41})`);
  return { walletHex41, walletB58: toB58(walletHex41), MultiSigWallet, deployedFresh: true };
}

async function main() {
  const deployerB58 = tronWeb.defaultAddress.base58;
  const deployerHex = tronWeb.defaultAddress.hex;
  const ownerPk = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;

  const { walletHex41, walletB58, MultiSigWallet, deployedFresh } = await ensureWallet(deployerHex, ownerPk);
  const wallet = await tronWeb.contract(MultiSigWallet.abi, walletB58);

  console.log(`\n╭ Deployer: ${deployerB58}`);
  console.log(`╰ Wallet  : ${walletB58} v${await wallet.version().call()}`);

  // Need TP > VOTE_TP and stake for delegation tests
  const FUND_FRESH_TRX = 600n;
  const STAKE_FRESH_BW_TRX = 200n;
  const STAKE_FRESH_ENERGY_TRX = 200n;

  if (deployedFresh) {
    console.log(`\n┏ Fund wallet with ${FUND_FRESH_TRX} TRX`);
    const fundTx = await tronWeb.trx.sendTrx(walletB58, Number(FUND_FRESH_TRX * SUN_PER_TRX));
    await waitTxInfo(fundTx.txid || fundTx.transaction.txID);
    console.log(`┗ wallet balance: ${TronWeb.fromSun(await tronWeb.trx.getBalance(walletB58))} TRX`);
    await sleep();

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
            (STAKE_FRESH_BW_TRX * SUN_PER_TRX).toString(),
            RES_BANDWIDTH,
          ]),
        },
      ],
      `freezeBalanceV2(${STAKE_FRESH_BW_TRX} TRX, BANDWIDTH)`,
    );
    await sleep();
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
            (STAKE_FRESH_ENERGY_TRX * SUN_PER_TRX).toString(),
            RES_ENERGY,
          ]),
        },
      ],
      `freezeBalanceV2(${STAKE_FRESH_ENERGY_TRX} TRX, ENERGY)`,
    );
    await sleep();
  }

  const r0w = await printResources("wallet", walletB58);
  const r0d = await printResources("deployer", deployerB58);

  // ---------- 1. BANDWIDTH delegate / undelegate ----------
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
          (DELEGATE_BW_TRX * SUN_PER_TRX).toString(),
          toHex20(deployerHex),
          RES_BANDWIDTH,
        ]),
      },
    ],
    `delegateResource(${DELEGATE_BW_TRX} TRX, deployer, BANDWIDTH)`,
  );
  await sleep();
  const r1w = await printResources("wallet", walletB58);
  const r1d = await printResources("deployer", deployerB58);
  if (r1w.netLimit >= r0w.netLimit) throw new Error("wallet Net did not drop after delegate BW");
  if (r1d.netLimit <= r0d.netLimit) throw new Error("deployer Net did not increase");
  console.log(
    `✅ BANDWIDTH delegated: wallet -${r0w.netLimit - r1w.netLimit}, deployer +${r1d.netLimit - r0d.netLimit}`,
  );

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
          (DELEGATE_BW_TRX * SUN_PER_TRX).toString(),
          toHex20(deployerHex),
          RES_BANDWIDTH,
        ]),
      },
    ],
    `undelegateResource(${DELEGATE_BW_TRX} TRX, deployer, BANDWIDTH)`,
  );
  await sleep();
  const r2w = await printResources("wallet", walletB58);
  const r2d = await printResources("deployer", deployerB58);
  if (r2w.netLimit <= r1w.netLimit) throw new Error("wallet Net did not return after undelegate BW");
  if (r2d.netLimit >= r1d.netLimit) throw new Error("deployer Net did not drop after undelegate BW");
  console.log(
    `✅ BANDWIDTH reclaimed: wallet +${r2w.netLimit - r1w.netLimit}, deployer -${r1d.netLimit - r2d.netLimit}`,
  );

  // ---------- 2. InvalidResourceType (unknown resource type) ----------
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("freezeBalanceV2(uint256,uint256)", [(1n * SUN_PER_TRX).toString(), RES_UNKNOWN]),
      },
    ],
    `freezeBalanceV2(1 TRX, resourceType=${RES_UNKNOWN}) — expect REVERT (InvalidResourceType)`,
    true,
  );
  console.log("✅ InvalidResourceType reverted");

  // ---------- 3. InvalidRecipient(0) for delegate ----------
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
          (1n * SUN_PER_TRX).toString(),
          ZERO_ADDR,
          RES_ENERGY,
        ]),
      },
    ],
    "delegateResource(1 TRX, 0x0, ENERGY) — expect REVERT (InvalidRecipient)",
    true,
  );
  console.log("✅ InvalidRecipient reverted (delegate)");

  // ---------- 4. InvalidRecipient(0) for undelegate ----------
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
          (1n * SUN_PER_TRX).toString(),
          ZERO_ADDR,
          RES_ENERGY,
        ]),
      },
    ],
    "undelegateResource(1 TRX, 0x0, ENERGY) — expect REVERT (InvalidRecipient)",
    true,
  );
  console.log("✅ InvalidRecipient reverted (undelegate)");

  // ---------- 5. voteWitnesses ----------
  const sr = await fetchShastaSr();
  console.log(`\n  Picked Shasta SR: ${sr} (${tronWeb.address.fromHex(sr)})`);
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("voteWitnesses(address[],uint256[])", [[toHex20(sr)], [VOTE_TP.toString()]]),
      },
    ],
    `voteWitnesses([${tronWeb.address.fromHex(sr)}], [${VOTE_TP}])`,
  );
  console.log("✅ voteWitnesses succeeded");

  // ---------- 6. InvalidVoteData (length mismatch) ----------
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("voteWitnesses(address[],uint256[])", [
          [toHex20(sr), toHex20(deployerHex)],
          [VOTE_TP.toString()],
        ]),
      },
    ],
    "voteWitnesses(2 srs, 1 amount) — expect REVERT (InvalidVoteData)",
    true,
  );
  console.log("✅ InvalidVoteData reverted");

  // ---------- 7. pendingReward (view) ----------
  const pending = await wallet.pendingReward().call();
  console.log(`\n  pendingReward(): ${pending.toString()} SUN`);
  console.log("✅ pendingReward callable");

  // ---------- 8. withdrawReward ----------
  await execAsOwner(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    [
      {
        to: walletHex41,
        value: 0n,
        data: encodeFunction("withdrawReward()", []),
      },
    ],
    "withdrawReward() [returns 0 — fresh vote]",
  );
  console.log("✅ withdrawReward callable");

  // ---------- 9. Direct EOA voteWitnesses must revert ----------
  await sendDirect(
    wallet,
    "voteWitnesses",
    [[toHex20(sr)], [1]],
    "owner EOA on an onlyFactory entry point — expect REVERT",
    unauthorized(deployerHex),
  );

  // ---------- 10. Enforced permissions, reserved range and signing domain ----------
  const supported = BigInt(await wallet.supportedPermissions().call());
  if (supported !== SUPPORTED_PERMISSIONS) {
    throw new Error(`supportedPermissions() = ${supported}, expected ${SUPPORTED_PERMISSIONS}`);
  }

  const boundary = BigInt(await wallet.BASE_PERMISSION_MASK().call());
  if (boundary !== BASE_PERMISSION_MASK) {
    throw new Error(`BASE_PERMISSION_MASK() = ${boundary}, expected ${BASE_PERMISSION_MASK}`);
  }

  const extensionPermissions = supported & ~boundary;
  if (extensionPermissions !== EXTENSION_PERMISSIONS) {
    throw new Error(
      `the extension adds ${extensionPermissions} above the base range, expected ${EXTENSION_PERMISSIONS}`,
    );
  }

  // Equality, not single-bit-ness: the union above is unchanged by swapping 128 and 129, so only the
  // per-constant value pins the positions the spec mandates.
  for (const [name, expected] of [
    ["PERMISSION_CLAIM", PERMISSION_CLAIM],
    ["PERMISSION_DELEGATE", PERMISSION_DELEGATE],
    ["PERMISSION_UNDELEGATE", PERMISSION_UNDELEGATE],
  ]) {
    const bit = BigInt(await wallet[name]().call());
    if (bit !== expected) {
      throw new Error(`${name}() = ${bit}, expected ${expected}`);
    }
  }

  // Keyed `type:name`, so the renamed event and errors are covered and not just the functions.
  const byMember = new Map(
    MultiSigWallet.abi.filter((entry) => entry.name).map((entry) => [`${entry.type}:${entry.name}`, entry]),
  );
  for (const member of [
    "function:PERMISSION_CLAIM",
    "function:PERMISSION_DELEGATE",
    "function:PERMISSION_UNDELEGATE",
    "function:BASE_PERMISSION_MASK",
    "function:supportedPermissions",
    "function:updatePermissions",
    "function:permissions",
    "function:permissionsOf",
    "function:hasPermission",
    "event:PermissionsChanged",
    "error:InvalidPermissionUpdate",
    "error:InvalidPermissionAccount",
    "error:UnsupportedPermissions",
    "error:ConflictingPermissions",
    "error:InvalidExtensionPermissions",
  ]) {
    if (!byMember.has(member)) {
      throw new Error(`${member} is missing from the compiled ABI`);
    }
  }
  for (const member of ["function:TVM_PERMISSIONS", "function:_extensionPermissions", "function:hasAnyPermission"]) {
    if (byMember.has(member)) {
      throw new Error(`${member} is published in the compiled ABI and must not be`);
    }
  }

  // The rule, not the list of names 1.2.x happened to publish: a 1.3.0 ABI names no whitelist, any spelling.
  const whitelistNamed = [...byMember.keys()].filter((member) => /whitelist/i.test(member));
  if (whitelistNamed.length > 0) {
    throw new Error(`the compiled ABI still names a whitelist: ${whitelistNamed.join(", ")}`);
  }

  // Every TVM reader unpacks `permissions()` by output name, so the names are pinned alongside the members.
  const permissionsOutputs = byMember.get("function:permissions").outputs.map((output) => output.name);
  if (permissionsOutputs.join(",") !== "accounts,masks") {
    throw new Error(`permissions() outputs = [${permissionsOutputs}], expected [accounts, masks]`);
  }

  // A log filter by account needs the topic, and a decoded event reads the same either way, so only the ABI shows it.
  const indexedEventInputs = byMember
    .get("event:PermissionsChanged")
    .inputs.filter((input) => input.indexed)
    .map((input) => input.name);
  if (indexedEventInputs.join(",") !== "account") {
    throw new Error(`PermissionsChanged indexes [${indexedEventInputs}], expected [account]`);
  }

  const eipDomain = await wallet.eip712Domain().call();
  const domainVersion = (eipDomain.version || eipDomain[2]).toString();
  const runtimeVersion = (await wallet.version().call()).toString();
  if (runtimeVersion !== EXPECTED_VERSION) {
    throw new Error(`version() = ${runtimeVersion}, expected ${EXPECTED_VERSION}`);
  }
  if (domainVersion !== runtimeVersion) {
    throw new Error(`eip712Domain().version = ${domainVersion}, version() = ${runtimeVersion}`);
  }

  console.log(`\n  supportedPermissions(): ${supported} (claim | delegate | undelegate)`);
  console.log(`  the extension adds ${extensionPermissions}, clear of the base range ${boundary}`);
  console.log(`  version() == eip712Domain().version == ${runtimeVersion}`);
  console.log("✅ TVM enforces claim plus its own permissions and signs under the base version");

  // ---------- 11. Owner without the permission cannot delegate directly ----------
  if ((await wallet.isOwner(toHex20(deployerHex)).call()) !== true) {
    throw new Error("deployer is not an owner, so the owner-without-permission case proves nothing");
  }
  const deployerMask = BigInt(await wallet.permissionsOf(toHex20(deployerHex)).call());
  if (deployerMask !== 0n) {
    throw new Error(`permissionsOf(deployer) = ${deployerMask}, expected 0 before the owner negative`);
  }

  await sendDirect(
    wallet,
    "delegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_BANDWIDTH],
    "owner holding no permission — expect REVERT (UnauthorizedAccount)",
    unauthorized(deployerHex),
  );
  console.log("✅ owner status alone does not authorize a direct delegation");

  // ---------- 12. Grant every permission to a separate account ----------
  const permitted = await ensurePermittedAccount();
  const permittedTronWeb = new TronWeb(PROVIDER_URI, PROVIDER_URI, PROVIDER_URI, permitted.pk);
  const walletAsPermitted = await permittedTronWeb.contract(MultiSigWallet.abi, walletB58);

  if ((await wallet.isOwner(toHex20(permitted.hex)).call()) !== false) {
    throw new Error("the permitted account is an owner, so its successful calls prove nothing");
  }

  const setPermittedTo = (grants, revokes, label) =>
    setPermissions(wallet, walletHex41, MultiSigWallet.abi, ownerPk, permitted.hex, grants, revokes, label);

  const grantedMask = await setPermittedTo(
    SUPPORTED_PERMISSIONS,
    0n,
    "updatePermissions(permitted, grant CLAIM | DELEGATE | UNDELEGATE)",
  );
  if (grantedMask !== SUPPORTED_PERMISSIONS) {
    throw new Error(`granted mask = ${grantedMask}, expected ${SUPPORTED_PERMISSIONS}`);
  }
  if ((await wallet.hasPermission(toHex20(permitted.hex), PERMISSION_CLAIM.toString()).call()) !== true) {
    throw new Error("hasPermission(permitted, CLAIM) = false after granting the claim permission");
  }
  console.log("✅ permissions granted through the multisig");
  await sleep();

  await sendDirect(
    walletAsPermitted,
    "freezeBalanceV2",
    [(1n * SUN_PER_TRX).toString(), RES_BANDWIDTH],
    "holder of every permission on an onlyFactory entry point — expect REVERT (UnauthorizedAccount)",
    unauthorized(permitted.hex),
  );
  console.log("✅ permissions widen no entry point that does not name them");
  await sleep();

  // ---------- 13. Permitted address claims directly ----------
  await sendDirect(
    walletAsPermitted,
    "claim",
    [ZERO_ADDR, [CLAIM_ID_PERMITTED]],
    "permitted non-owner — expect SUCCESS",
  );
  console.log("✅ claim reached by the claim permission, not by owner status");
  await sleep();

  // ---------- 14. Permitted address delegates and reclaims directly ----------
  const r3w = await printResources("wallet", walletB58);
  const r3d = await printResources("deployer", deployerB58);

  await sendDirect(
    walletAsPermitted,
    "delegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_BANDWIDTH],
    "permitted address — expect SUCCESS",
  );
  await sleep();
  const r4w = await printResources("wallet", walletB58);
  const r4d = await printResources("deployer", deployerB58);
  if (r4w.netLimit >= r3w.netLimit) throw new Error("wallet Net did not drop after direct delegate");
  if (r4d.netLimit <= r3d.netLimit) throw new Error("deployer Net did not increase after direct delegate");
  console.log(
    `✅ direct delegate moved resource: wallet -${r3w.netLimit - r4w.netLimit}, deployer +${r4d.netLimit - r3d.netLimit}`,
  );

  await sendDirect(
    walletAsPermitted,
    "undelegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_BANDWIDTH],
    "permitted address — expect SUCCESS",
  );
  await sleep();
  const r5w = await printResources("wallet", walletB58);
  if (r5w.netLimit <= r4w.netLimit) throw new Error("wallet Net did not return after direct undelegate");
  console.log(`✅ direct undelegate reclaimed resource: wallet +${r5w.netLimit - r4w.netLimit}`);
  await sleep();

  // ---------- 15. Argument validation on a direct permitted call ----------
  await sendDirect(
    walletAsPermitted,
    "delegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), ZERO_ADDR, RES_BANDWIDTH],
    "permitted address, zero receiver — expect REVERT (InvalidRecipient)",
    encodeError("InvalidRecipient(address)", [ZERO_ADDR]),
  );
  await sleep();

  await sendDirect(
    walletAsPermitted,
    "delegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_UNKNOWN],
    `permitted address, resourceType=${RES_UNKNOWN} — expect REVERT (InvalidResourceType)`,
    encodeError("InvalidResourceType(uint256)", [RES_UNKNOWN]),
  );
  console.log("✅ passing the permission gate still leaves the argument validation in force");
  await sleep();

  // ---------- 16. An owner granted the permission delegates directly ----------
  const ownerGrantedMask = await setPermissions(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    deployerHex,
    PERMISSION_DELEGATE,
    0n,
    "updatePermissions(owner, grant DELEGATE)",
  );
  if (ownerGrantedMask !== PERMISSION_DELEGATE) {
    throw new Error(`owner mask = ${ownerGrantedMask}, expected ${PERMISSION_DELEGATE}`);
  }
  await sleep();

  const r6d = await printResources("deployer", deployerB58);
  await sendDirect(
    wallet,
    "delegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_BANDWIDTH],
    "owner granted the delegate permission — expect SUCCESS",
  );
  await sleep();
  const r7d = await printResources("deployer", deployerB58);
  if (r7d.netLimit <= r6d.netLimit) {
    throw new Error("deployer Net did not increase after the owner's direct delegate");
  }
  console.log("✅ the grant opened the direct call an owner was refused at step 11");

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
          (DELEGATE_BW_TRX * SUN_PER_TRX).toString(),
          toHex20(deployerHex),
          RES_BANDWIDTH,
        ]),
      },
    ],
    `undelegateResource(${DELEGATE_BW_TRX} TRX, deployer, BANDWIDTH) through execute() — clean up the owner grant`,
  );
  await sleep();

  const ownerRevokedMask = await setPermissions(
    wallet,
    walletHex41,
    MultiSigWallet.abi,
    ownerPk,
    deployerHex,
    0n,
    PERMISSION_DELEGATE,
    "updatePermissions(owner, revoke DELEGATE)",
  );
  if (ownerRevokedMask !== 0n) {
    throw new Error(`owner mask after revoke = ${ownerRevokedMask}, expected 0`);
  }
  await sleep();

  // ---------- 17. Revoking claim and undelegate leaves delegation intact ----------
  const delegateOnlyMask = await setPermittedTo(
    0n,
    PERMISSION_CLAIM | PERMISSION_UNDELEGATE,
    "updatePermissions(permitted, revoke CLAIM | UNDELEGATE)",
  );
  if (delegateOnlyMask !== PERMISSION_DELEGATE) {
    throw new Error(`mask after revoke = ${delegateOnlyMask}, expected ${PERMISSION_DELEGATE}`);
  }
  if ((await wallet.hasPermission(toHex20(permitted.hex), PERMISSION_CLAIM.toString()).call()) !== false) {
    throw new Error("hasPermission(permitted, CLAIM) = true after revoking the claim permission");
  }
  await sleep();

  await sendDirect(
    walletAsPermitted,
    "claim",
    [ZERO_ADDR, [CLAIM_ID_REVOKED]],
    "claim permission revoked — expect REVERT (UnauthorizedAccount)",
    unauthorized(permitted.hex),
  );
  await sleep();

  const r8d = await printResources("deployer", deployerB58);
  await sendDirect(
    walletAsPermitted,
    "delegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_BANDWIDTH],
    "delegate permission still held — expect SUCCESS",
  );
  await sleep();
  const r9d = await printResources("deployer", deployerB58);
  if (r9d.netLimit <= r8d.netLimit) {
    throw new Error("deployer Net did not increase, so the undelegate below would have nothing to return");
  }

  // The delegation above is live, so a missing permission is the only thing left to reject this.
  await sendDirect(
    walletAsPermitted,
    "undelegateResource",
    [(DELEGATE_BW_TRX * SUN_PER_TRX).toString(), toHex20(deployerHex), RES_BANDWIDTH],
    "holder of the delegate permission only — expect REVERT (UnauthorizedAccount)",
    unauthorized(permitted.hex),
  );
  console.log("✅ each permission gates only the call that names it");
  await sleep();

  // ---------- 18. The multisig queue still reaches the gated calls ----------
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
          (DELEGATE_BW_TRX * SUN_PER_TRX).toString(),
          toHex20(deployerHex),
          RES_BANDWIDTH,
        ]),
      },
    ],
    `undelegateResource(${DELEGATE_BW_TRX} TRX, deployer, BANDWIDTH) through execute() — no permission needed`,
  );
  console.log("✅ execute() reaches the gated calls regardless of permissions");
  await sleep();

  // ---------- 19. Revoking the last permission removes the entry ----------
  const emptyMask = await setPermittedTo(0n, SUPPORTED_PERMISSIONS, "updatePermissions(permitted, revoke everything)");
  if (emptyMask !== 0n) {
    throw new Error(`mask after full revoke = ${emptyMask}, expected 0`);
  }

  const entries = await wallet.permissions().call();
  const entryAccounts = entries.accounts || entries[0];
  if (!Array.isArray(entryAccounts)) {
    throw new Error("permissions() did not decode into an accounts array");
  }
  const stillListed = entryAccounts.some((a) => toHex20(a.toString()) === toHex20(permitted.hex));
  if (stillListed) {
    throw new Error("permitted address still present in permissions() after full revoke");
  }
  console.log("✅ the entry left the permission index");

  console.log("\nAll extras passed ✅");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
