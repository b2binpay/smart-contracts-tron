const { TronWeb } = require("tronweb");
const {
  keccak256,
  solidityPackedKeccak256,
  getBytes,
  recoverAddress,
  formatUnits,
  parseUnits,
  Interface,
  Wallet,
  TypedDataEncoder,
} = require("ethers");

const fs = require("node:fs");
const path = require("node:path");

const {
  DEPOSITS,
  ERC20_NAME,
  ERC20_SYMBOL,
  ERC20_INITIAL_SUPPLY,
  TRON_FEE_LIMIT,
  PERMISSION_CLAIM,
} = require("./utils/constants");

const SOLC_TARGET = process.env.SOLC_TARGET || "0.8.25";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const PROVIDER_URI = process.env.PROVIDER_URI || "http://127.0.0.1:9090";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(__dirname, `../build/${SOLC_TARGET}/contracts`);

const tronWeb = new TronWeb(PROVIDER_URI, PROVIDER_URI, PROVIDER_URI, PRIVATE_KEY);

/**
 * The claim list, filtered out of the permission index. TronWeb may hand a multi-output call back as a
 * positional tuple rather than by output name, so both shapes are read. A decode that yields neither
 * shape throws here rather than printing an empty list, which would read as "nobody holds the claim bit".
 */
async function claimHolders(wallet) {
  const entries = await wallet.permissions().call();
  const accounts = entries.accounts || entries[0];
  const masks = entries.masks || entries[1];

  return accounts.filter((_, i) => (BigInt(masks[i]) & PERMISSION_CLAIM) !== 0n);
}

async function main() {
  // ---------- Load artifacts ----------
  const ProxyFactory = readArtifact("ProxyFactory");
  const MultiSigWallet = readArtifact("MultiSigWallet");
  const DepositAccount = readArtifact("DepositAccount");
  const ERC20Mock = readArtifact("ERC20Mock");

  // ---------- Generate owners ----------
  const owner1 = await TronWeb.createAccount();
  const owner2 = await TronWeb.createAccount();

  const ownersBase58 = [owner1.address.base58, owner2.address.base58];
  const owners = ownersBase58.map((a) => tronWeb.address.toHex(a)); // 41...
  const threshold = 1;

  const deployerAddress = tronWeb.defaultAddress.base58;

  console.log(`╭ Deployer: ${deployerAddress} (${TronWeb.fromSun(await tronWeb.trx.getBalance(deployerAddress))} TRX)`);
  console.log(`| Owner #1: ${ownersBase58[0]} (${TronWeb.fromSun(await tronWeb.trx.getBalance(ownersBase58[0]))} TRX)`);
  console.log(`| Owner #2: ${ownersBase58[1]} (${TronWeb.fromSun(await tronWeb.trx.getBalance(ownersBase58[1]))} TRX)`);
  console.log(`╰     Solc: ${SOLC_TARGET}`);

  /**
   * ERC20Mock
   */
  const token = await tronWeb.contract().new({
    abi: ERC20Mock.abi,
    bytecode: ERC20Mock.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [ERC20_NAME, ERC20_SYMBOL, ERC20_INITIAL_SUPPLY.toString()],
  });
  console.log(`\n┏ 'ERC20Mock' \n┗ ${token.address} [${toB58(token.address)}]`);

  await sleep();

  const tokenContract = await tronWeb.contract(ERC20Mock.abi, toB58(token.address));
  const tokenDecimals = Number(await tokenContract.decimals().call());
  console.log(
    "  ┣   Info:",
    await tokenContract.name().call(),
    "(",
    await tokenContract.symbol().call(),
    ") [",
    tokenDecimals,
    "]",
  );
  console.log("  ┣ Supply:", formatUnits((await tokenContract.totalSupply().call()).toString(), tokenDecimals));
  console.log(
    "  ┗  Owner:",
    formatUnits((await tokenContract.balanceOf(tronWeb.defaultAddress.base58).call()).toString(), tokenDecimals),
  );

  /**
   * ProxyFactory
   */
  const proxy = await tronWeb.contract().new({
    abi: ProxyFactory.abi,
    bytecode: ProxyFactory.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [],
  });

  console.log(`\n┏ 'ProxyFactory' \n┗ ${proxy.address} [${toB58(proxy.address)}]`);

  /**
   * MultiSigWallet (master copy / implementation)
   * Deploy as implementation contract for ERC-1167 clones
   */
  const multiSigWalletImplementation = await tronWeb.contract().new({
    abi: MultiSigWallet.abi,
    bytecode: MultiSigWallet.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [],
  });
  console.log(
    `\n┏ 'MultiSigWallet' implementation (master copy) \n┗ ${multiSigWalletImplementation.address} [${toB58(multiSigWalletImplementation.address)}]`,
  );

  await sleep();

  console.log(`\n| Compute CREATE2 addresses for wallets (owners: ${owners.length}, threshold: ${threshold}) |`);

  const initializer = encodeSetup(owners, threshold);

  // ERC-1167 clone bytecode: 0x3d602d80600a3d3981f3363d3d373d3d3d363d73 + implementation (20 bytes) + 0x5af43d82803e903d91602b57fd5bf3
  const implementationHex = toHex20(multiSigWalletImplementation.address);
  const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementationHex.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const cloneBytecodeHash = keccak256(getBytes(cloneBytecode));

  const walletIds = DEPOSITS.map((wallet) => wallet.id);

  const offchainWallets = walletIds.map((id) => {
    const salt = computeSaltPacked(initializer, id);
    return computeCreate2AddressTVM(proxy.address, salt, cloneBytecodeHash);
  });

  const onchainWallets = [];
  for (const id of walletIds) {
    const ret = await proxy.computeAddress(multiSigWalletImplementation.address, initializer, id).call();
    const addr = ret.instance || ret["1"] || ret[1];
    onchainWallets.push(addr);
  }

  console.table(
    DEPOSITS.map((wallet, i) => ({
      ID: wallet.id,
      Proxy: onchainWallets[i],
      CREATE2: offchainWallets[i],
      x: onchainWallets[i].toLowerCase() === offchainWallets[i].toLowerCase() ? "✅" : "❌",
    })),
  );

  console.log(`\n╭ Create wallet with ID [${DEPOSITS[0].id}] (owners: ${owners.length}, threshold: ${threshold}) |`);
  let tx = await proxy
    .createInstance(multiSigWalletImplementation.address, initializer, DEPOSITS[0].id)
    .send({ feeLimit: TRON_FEE_LIMIT });
  console.log("╰ tx:", tx);

  // Wait for receipt to avoid reading non-existent contract
  try {
    const info = await waitTxInfo(tronWeb, tx);
    console.log("  ╰ result:", info?.receipt?.result || info.result);
  } catch (_e) {
    console.log("  ╰ result: REVERT (factory createInstance failed)");
    return;
  }

  await sleep();

  const walletHex = onchainWallets[0];
  const wallet = await tronWeb.contract(MultiSigWallet.abi, toB58(walletHex));
  const eip712Domain = await wallet.eip712Domain().call();
  console.log(`\n┏ 'MultiSigWallet' \n┗ ${walletHex} [${toB58(walletHex)}]`);
  console.log(
    `  ┣ EIP712   : name=${eip712Domain.name}, version=${eip712Domain.version}, chainId=${eip712Domain.chainId}`,
  );
  console.log("  ┣ Version  :", await wallet.version().call());
  console.log("  ┣ Threshold:", (await wallet.threshold().call()).toString());
  console.log("  ┣ Owners   :", await wallet.owners().call());
  console.log("  ┗ Permitted:", await claimHolders(wallet));

  console.log("\n| Compute CREATE2 addresses for deposits (using data before creating the wallet) |");

  const depositIds = DEPOSITS.map((x) => x.id);
  const depositBytecodeHash = bytecodeHash(DepositAccount.bytecode);

  const offchainDeposits = depositIds.map((id) => {
    return computeCreate2AddressTVM(walletHex, id, depositBytecodeHash);
  });

  const retAcc = await wallet.getAccounts(depositIds).call();
  const onchainDeposits = retAcc.accounts || retAcc["1"] || retAcc[1];

  console.table(
    depositIds.map((id, i) => ({
      ID: id,
      Wallet: onchainDeposits[i],
      CREATE2: offchainDeposits[i],
      x: (onchainDeposits[i] || "").toLowerCase() === (offchainDeposits[i] || "").toLowerCase() ? "✅" : "❌",
    })),
  );

  console.log("\n| DEMO |\n");

  console.log("\n╭ Grant the deployer the claim permission |");
  {
    const deployerHex20 = toHex20(tronWeb.defaultAddress.hex);
    const data = encodeFunction("updatePermissions(address[],uint256[],uint256[])", [
      [deployerHex20],
      [PERMISSION_CLAIM],
      [0n],
    ]);
    const calls = [{ to: walletHex, value: 0n, data }];

    const { digest, signature } = await signExecuteCalls(walletHex, calls, null, null, owner1.privateKey);

    const packed = packSignatures(digest, [signature]);
    const tx = await executeOps(wallet, calls, packed);
    await waitTxInfo(tronWeb, tx);
    await sleep();
    console.log(`| Claim permission holders: ${await claimHolders(wallet)}`);
    console.log(`╰ Deployer permissions: ${await wallet.permissionsOf(deployerHex20).call()}`);
  }

  console.log("\n╭ Fund 0.01 TRX & 10 ERC20 to deposit #0 |");
  await fund(0, "0.01", "10");
  await print([0]);

  console.log("\n╭ Fund 0.01 TRX & 10 ERC20 to deposit #0 |");
  await fund(0, "0.01", "10");
  await print([0]);

  console.log("\n╭ Claim only TRX from deposit #0 |");
  tx = await wallet.claim(ZERO_ADDRESS, [DEPOSITS[0].id]).send({ feeLimit: TRON_FEE_LIMIT });
  console.log(`╰ tx: ${tx}`);
  await sleep();
  await print([0]);

  console.log("\n╭ Claim only ERC20 from deposit #0 |");
  tx = await wallet.claim(token.address, [DEPOSITS[0].id]).send({ feeLimit: TRON_FEE_LIMIT });
  console.log(`╰ tx: ${tx}`);
  await sleep();
  await print([0]);

  console.log("\n╭ Fund 0.01 TRX & 10 ERC20 to deposit #0 |");
  await fund(0, "0.01", "10");
  await print([0, 1]);

  console.log("\n╭ Fund 0.01 TRX & 10 ERC20 to deposit #1 |");
  await fund(1, "0.01", "10");
  await print([0, 1]);

  console.log("\n╭ Batch claim TRX & ERC20 from deposit #0 & #1 |");
  tx = await wallet.claim(token.address, [DEPOSITS[0].id, DEPOSITS[1].id]).send({ feeLimit: TRON_FEE_LIMIT });
  console.log(`╰ tx: ${tx}`);
  await sleep();
  await print([0, 1]);

  console.log("\n╭ Payout 0.01 TRX from first owner to deployer |");
  {
    // Build single native TRX transfer call
    const calls = [
      {
        to: tronWeb.defaultAddress.hex,
        value: parseSun("0.01"), // 0.01 TRX → SUN
        data: "0x",
      },
    ];

    // Sign EIP-712 Execute(calls, nonce) with owner1
    const { digest, signature } = await signExecuteCalls(
      walletHex, // 0x41… wallet hex
      calls, // Call[]
      null, // nonce (null => read from contract)
      null, // version (null => read from contract)
      owner1.privateKey,
    );

    const packed = packSignatures(digest, [signature]);
    const tx = await executeOps(wallet, calls, packed);
    console.log(`╰ tx: ${tx}`);
    await waitTxInfo(tronWeb, tx);

    await sleep();
    await print([0, 1]);
  }

  console.log("\n╭ Payout 10 ERC20 from second owner to deployer |");
  {
    const calls = [
      {
        to: token.address,
        value: 0n,
        data: encodeFunction("transfer(address,uint256)", [
          toHex20(tronWeb.defaultAddress.hex),
          parseUnits("10", tokenDecimals).toString(),
        ]),
      },
    ];

    const { digest, signature } = await signExecuteCalls(
      walletHex, // 0x41… wallet hex
      calls, // Call[]
      null, // nonce (null => read from contract)
      null, // version (null => read from contract)
      owner2.privateKey,
    );

    const packed = packSignatures(digest, [signature]);
    const tx = await executeOps(wallet, calls, packed);
    console.log(`╰ tx: ${tx}`);
    await waitTxInfo(tronWeb, tx);

    await sleep();
    await print([0, 1]);
  }

  console.log("\n╭ Setup threshold to 2 |");
  {
    const owners0x = toHex20(owners);
    const data = encodeFunction("setConfig(address[],uint256)", [owners0x, "2"]);
    const calls = [{ to: walletHex, value: 0n, data }];

    const { digest, signature } = await signExecuteCalls(
      walletHex,
      calls,
      null, // nonce from contract
      null, // version from contract
      owner1.privateKey,
    );

    const packed = packSignatures(digest, [signature]);
    const tx = await executeOps(wallet, calls, packed);
    await waitTxInfo(tronWeb, tx);
    await sleep();

    console.log(`╰ tx: ${tx}`);
    console.log("  ╰ Threshold:", (await wallet.threshold().call()).toString());
  }

  console.log("\n╭ Try payout 0.03 TRX & 30 ERC20 only from owner1 [should revert] |");
  {
    const calls = [
      { to: tronWeb.defaultAddress.hex, value: parseSun("0.03"), data: "0x" },
      {
        to: token.address,
        value: 0n,
        data: encodeFunction("transfer(address,uint256)", [
          toHex20(tronWeb.defaultAddress.hex),
          parseUnits("30", tokenDecimals).toString(),
        ]),
      },
    ];

    try {
      const { digest, signature } = await signExecuteCalls(walletHex, calls, null, null, owner1.privateKey);
      const packed = packSignatures(digest, [signature]);
      const tx = await executeOps(wallet, calls, packed);
      console.log(`╰ tx: ${tx}`);

      const info = await waitTxInfo(tronWeb, tx);
      console.log("  ╰ result:", info.result);

      if (info.result !== "FAILED") {
        console.warn("Transaction succeeded, but should fail!");
        return;
      }
    } catch (error) {
      console.log("  ╰ error:", error?.message || error);
    }
    await print([0, 1]);
  }

  console.log("\n╭ Payout 0.03 TRX & 30 ERC20 from owners to deployer [batch] |");
  {
    const calls = [
      { to: tronWeb.defaultAddress.hex, value: parseSun("0.03"), data: "0x" },
      {
        to: token.address,
        value: 0n,
        data: encodeFunction("transfer(address,uint256)", [
          toHex20(tronWeb.defaultAddress.hex),
          parseUnits("30", tokenDecimals).toString(),
        ]),
      },
    ];
    const nonceNow = await wallet.nonce().call();

    const s1 = await signExecuteCalls(walletHex, calls, nonceNow, null, owner1.privateKey);
    const s2 = await signExecuteCalls(walletHex, calls, nonceNow, null, owner2.privateKey);
    const signature = packSignatures(s1.digest, [s1.signature, s2.signature]);

    const tx = await executeOps(wallet, calls, signature);
    console.log(`╰ tx: ${tx}`);
    await waitTxInfo(tronWeb, tx);

    await sleep();
    await print([0, 1]);
  }

  console.log("\n╭ Fund 100 ERC20 directly to wallet |");
  {
    // Send ERC20 to wallet
    const amount = parseUnits("100", tokenDecimals).toString();
    const tx = await tokenContract.transfer(toB58(walletHex), amount).send({ feeLimit: TRON_FEE_LIMIT });
    console.log(`╰ tx: ${tx}`);

    await sleep();
    await print([0, 1]);

    const allowance = await tokenContract.allowance(toB58(walletHex), tronWeb.defaultAddress.base58).call();
    console.log(`| Allowance for deployer: ${formatUnits(allowance, tokenDecimals)} ${ERC20_SYMBOL}`);
  }

  console.log("\n╭ Execute a direct transfer and approve 100 ERC20 |");
  {
    const encodedData1 = encodeFunction("transfer(address,uint256)", [
      toHex20(tronWeb.defaultAddress.hex),
      parseUnits("100", tokenDecimals).toString(),
    ]);

    const encodedData2 = encodeFunction("approve(address,uint256)", [
      toHex20(tronWeb.defaultAddress.hex),
      parseUnits("100", tokenDecimals).toString(),
    ]);

    const calls = [
      { to: token.address, value: 0n, data: encodedData1 },
      { to: token.address, value: 0n, data: encodedData2 },
    ];

    const nonceNow = await wallet.nonce().call();

    const s1 = await signExecuteCalls(walletHex, calls, nonceNow, null, owner1.privateKey);
    const s2 = await signExecuteCalls(walletHex, calls, nonceNow, null, owner2.privateKey);
    const signature = packSignatures(s1.digest, [s1.signature, s2.signature]);

    const tx = await executeOps(wallet, calls, signature);
    console.log(`╰ tx: ${tx}`);
    await waitTxInfo(tronWeb, tx);

    await sleep();
    await print([0, 1]);

    const allowance = await tokenContract.allowance(toB58(walletHex), tronWeb.defaultAddress.base58).call();
    console.log(`| Allowance for deployer: ${formatUnits(allowance, tokenDecimals)} ${ERC20_SYMBOL}`);
  }

  console.log("\n╭ Fund 200 ERC20 directly to wallet |");
  {
    // Send ERC20 to wallet
    const amount = parseUnits("200", tokenDecimals).toString();
    const tx = await tokenContract.transfer(toB58(walletHex), amount).send({ feeLimit: TRON_FEE_LIMIT });
    console.log(`╰ tx: ${tx}`);

    await sleep();
    await print([0, 1]);

    const allowance = await tokenContract.allowance(toB58(walletHex), tronWeb.defaultAddress.base58).call();
    console.log(`| Allowance for deployer: ${formatUnits(allowance, tokenDecimals)} ${ERC20_SYMBOL}`);
  }

  console.log("\n╭ Execute a direct transfer and approve 100 ERC20 (twice) |");
  {
    const calls = [
      {
        to: token.address,
        value: 0n,
        data: encodeFunction("transfer(address,uint256)", [
          toHex20(tronWeb.defaultAddress.hex),
          parseUnits("100", tokenDecimals).toString(),
        ]),
      },
      {
        to: token.address,
        value: 0n,
        data: encodeFunction("approve(address,uint256)", [
          toHex20(tronWeb.defaultAddress.hex),
          parseUnits("100", tokenDecimals).toString(),
        ]),
      },
    ];

    const nonceA = await wallet.nonce().call();
    const nonceB = BigInt(nonceA) + 1n;

    const a1 = await signExecuteCalls(walletHex, calls, nonceA, null, owner1.privateKey);
    const a2 = await signExecuteCalls(walletHex, calls, nonceA, null, owner2.privateKey);
    const aSigs = packSignatures(a1.digest, [a1.signature, a2.signature]);

    const b1 = await signExecuteCalls(walletHex, calls, nonceB, null, owner1.privateKey);
    const b2 = await signExecuteCalls(walletHex, calls, nonceB, null, owner2.privateKey);
    const bSigs = packSignatures(b1.digest, [b1.signature, b2.signature]);

    const tupleCalls = calls.map((c) => [toHex41(c.to), BigInt(c.value).toString(), c.data]);

    const tupleOps = [
      [tupleCalls, aSigs, `0x${"00".repeat(32)}`],
      [tupleCalls, bSigs, `0x${"00".repeat(32)}`],
    ];

    const tx = await wallet.execute(tupleOps).send({ feeLimit: TRON_FEE_LIMIT });
    console.log(`╰ tx: ${tx}`);
    await waitTxInfo(tronWeb, tx);

    await sleep();
    await print([0, 1]);

    const allowance = await tokenContract.allowance(toB58(walletHex), tronWeb.defaultAddress.base58).call();
    console.log(`| Allowance for deployer: ${formatUnits(allowance, tokenDecimals)} ${ERC20_SYMBOL}`);
  }

  /**
   * Helpers
   */

  function sleep(ms = 60_000) {
    if (process.env.PROVIDER_URI === "http://127.0.0.1:9090") return;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function readArtifact(name) {
    return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, `${name}.json`), "utf8"));
  }

  function toB58(hex41) {
    return tronWeb.address.fromHex(hex41);
  }

  function toHex20(addresses) {
    const arr = Array.isArray(addresses) ? addresses : [addresses];
    const out = arr.map((addr) => {
      if (typeof addr !== "string") return addr;
      if (addr.startsWith("T")) {
        const hex41 = tronWeb.address.toHex(addr);
        const core20 = hex41.startsWith("41") ? hex41.slice(2) : hex41.replace(/^0x41/i, "");
        return `0x${core20}`;
      }
      if (addr.startsWith("0x")) {
        const hex = addr.slice(2);
        const without41 = hex.startsWith("41") && hex.length >= 42 ? hex.slice(2) : hex;
        return `0x${without41.padStart(40, "0")}`;
      }
      if (addr.startsWith("41")) {
        return `0x${addr.slice(2)}`;
      }
      return addr;
    });
    return Array.isArray(addresses) ? out : out[0];
  }

  function toHex41(addr) {
    // Normalize to TRON hex without 0x, starting with 41…
    if (typeof addr !== "string") return addr;
    let hex = addr;
    if (hex.startsWith("T")) hex = tronWeb.address.toHex(hex);
    if (hex.startsWith("0x")) hex = hex.slice(2);
    if (!hex.startsWith("41")) hex = `41${hex}`;
    return hex;
  }

  function encodeSetup(owners, threshold) {
    const ownersHex = toHex20(owners);
    const selector = tronWeb.sha3("setup(address[],uint256)").slice(0, 10);
    const encoded = tronWeb.utils.abi.encodeParams(["address[]", "uint256"], [ownersHex, String(threshold)]);
    return selector + encoded.slice(2);
  }

  /**
   * Encode function by signature with ethers
   */
  function encodeFunction(sig, args) {
    const fn = sig.replace(/\s+/g, "");
    const match = fn.match(/^(\w+)\((.*)\)$/);
    if (!match) throw new Error("Invalid function signature");
    const name = match[1];
    const types = match[2].length ? match[2].split(",").map((s) => s.trim()) : [];
    const iface = new Interface([`function ${name}(${types.map((t, i) => `${t} a${i}`).join(",")})`]);
    return iface.encodeFunctionData(name, args);
  }

  function computeSaltPacked(initializerHex, idBytes32) {
    const initHash = keccak256(getBytes(initializerHex));
    return solidityPackedKeccak256(["bytes32", "bytes32"], [initHash, idBytes32]);
  }

  function bytecodeHash(creationBytecode) {
    return keccak256(getBytes(creationBytecode));
  }

  // TVM CREATE2 (0x41 prefix): for plain bytecode hash (e.g., DepositAccount)
  function computeCreate2AddressTVM(deployer, salt32, bytecodeHash32) {
    let deployerHex = tronWeb.address.toHex(deployer);
    if (!deployerHex.startsWith("0x")) deployerHex = `0x${deployerHex}`;

    const deployerBytes = getBytes(deployerHex); // [0x41, <20>]
    const prefix = new Uint8Array([0x41]);
    const addr20 = deployerBytes.slice(1);

    const saltBytes = getBytes(salt32.startsWith("0x") ? salt32 : `0x${salt32}`);
    const codeHashBytes = getBytes(bytecodeHash32.startsWith("0x") ? bytecodeHash32 : `0x${bytecodeHash32}`);

    const packed = new Uint8Array(1 + 20 + 32 + 32);
    packed.set(prefix, 0);
    packed.set(addr20, 1);
    packed.set(saltBytes, 1 + 20);
    packed.set(codeHashBytes, 1 + 20 + 32);

    const h = keccak256(packed);
    const last20 = h.slice(2 + 24);
    return `41${last20}`;
  }

  async function signExecuteCalls(walletHex41, calls, nonceOpt, versionOpt, pk) {
    const walletB58 = tronWeb.address.fromHex(walletHex41);
    const w = await tronWeb.contract(MultiSigWallet.abi, walletB58);

    // Read domain from on-chain EIP712 (IERC5267)
    const d = await w.eip712Domain().call();
    const name = (d.name || d[1] || "MultiSigWallet").toString();
    const version = (versionOpt || d.version || d[2] || "1.0.0").toString();
    const chainId = BigInt(d.chainId || d[3]);
    const verifyingContract = toHex20(walletHex41); // 0x + 20 bytes, without 41

    // Normalize calls for typed data
    const normalizedCalls = calls.map((c) => ({
      to: toHex20(c.to), // 0x + 20 bytes
      value: BigInt(c.value), // uint256
      data: c.data, // bytes
    }));

    // Resolve nonce
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

    // EIP-712 signing
    const wallet = new Wallet(pk);
    const signature = await wallet.signTypedData(domain, types, message);

    // Digest for debugging (not required)
    const digest = TypedDataEncoder.hash(domain, types, message);

    return { digest, signature };
  }

  /**
   * Pack ECDSA signatures into the format expected by checkSignatures:
   * [signer:20 bytes][sigLen:2 bytes uint16 BE][sig:sigLen bytes] × N
   * Recovers signer addresses and sorts ascending.
   */
  function packSignatures(digest, sigs) {
    const items = sigs.map((s) => {
      const signer = recoverAddress(digest, s).toLowerCase();
      return { signer, signature: s };
    });
    items.sort((a, b) => a.signer.localeCompare(b.signer));

    const parts = items.map(({ signer, signature }) => {
      const signerHex = signer.startsWith("0x") ? signer.slice(2) : signer;
      const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
      const sigLen = sigHex.length / 2;
      const sigLenHex = sigLen.toString(16).padStart(4, "0");
      return `${signerHex}${sigLenHex}${sigHex}`;
    });

    return `0x${parts.join("")}`;
  }

  function parseSun(trx) {
    return BigInt(Math.floor(Number.parseFloat(String(trx)) * 1e6));
  }

  /**
   * Wait until account balance increases (compared to a reference) or reaches a target
   * @param {TronWeb} tronWeb
   * @param {string} address
   * @param {{ refSun: bigint, minSun: bigint, timeoutMs: number, intervalMs: number }} options
   * @returns {Promise<{ balanceSun: bigint, deltaSun: bigint }>}
   */
  async function waitBalance(tronWeb, address, { refSun, minSun, timeoutMs = 180000, intervalMs = 3000 } = {}) {
    let base58 = address;
    if (typeof address === "string" && (address.startsWith("0x") || address.startsWith("41"))) {
      base58 = tronWeb.address.fromHex(address);
    }

    // Read initial balance if not provided
    const start = Date.now();
    let ref = typeof refSun === "bigint" ? refSun : undefined;
    if (ref === undefined) {
      const b = await tronWeb.trx.getBalance(base58);
      ref = BigInt(b);
    }
    const target = typeof minSun === "bigint" ? minSun : undefined;

    while (Date.now() - start < timeoutMs) {
      const cur = BigInt(await tronWeb.trx.getBalance(base58));

      // Resolve if reached target
      if (target !== undefined && cur >= target) {
        return { balanceSun: cur, deltaSun: cur - ref };
      }

      // Resolve if increased over reference
      if (target === undefined && cur > ref) {
        return { balanceSun: cur, deltaSun: cur - ref };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Balance for ${base58} not updated within ${timeoutMs}ms ${target !== undefined ? `(expected >= ${target} SUN)` : `(expected > ${ref} SUN)`}`,
    );
  }

  async function sendERC20(toHex41, amountStr) {
    const to = toB58(toHex41);
    const amount = BigInt(Number.parseFloat(amountStr) * 10 ** tokenDecimals);
    const tx = await tokenContract.transfer(to, amount.toString()).send({ feeLimit: TRON_FEE_LIMIT });

    const info = await waitTxInfo(tronWeb, tx);
    console.log(`├ tx: ${info.id}`);

    return tx;
  }

  async function sendTRX(toHex41, trxStr) {
    const to = toB58(toHex41);

    const beforeSun = BigInt(await tronWeb.trx.getBalance(to));

    const tx = await tronWeb.trx.sendTransaction(to, parseSun(trxStr));
    console.log(`╰ tx: ${tx.txid}`);

    // Wait until balance reaches before + amount
    const targetSun = beforeSun + parseSun(trxStr);
    const info = await waitBalance(tronWeb, to, { minSun: targetSun, timeoutMs: 360000, intervalMs: 10000 });
    console.log("  ╰ balance:", info.balanceSun.toString(), "Δ:", info.deltaSun.toString());

    return tx;
  }

  async function fund(idx, amountTRX, amountToken) {
    const depHex = onchainDeposits[idx];
    await sendERC20(depHex, amountToken);
    await sendTRX(depHex, amountTRX);
    await sleep();
  }

  async function print(indexes) {
    const table = [];
    for (const idx of indexes) {
      const depositHex = onchainDeposits[idx];
      const depositB58 = toB58(depositHex);
      const trxDeposit = TronWeb.fromSun(await tronWeb.trx.getBalance(depositB58));
      const tokenDeposit = formatUnits(await tokenContract.balanceOf(depositB58).call(), tokenDecimals);
      table.push({
        Type: "💰",
        Address: depositHex,
        TRX: trxDeposit,
        [ERC20_SYMBOL]: tokenDeposit,
      });
    }
    const walletB58 = toB58(walletHex);
    const trxWallet = TronWeb.fromSun(await tronWeb.trx.getBalance(walletB58));
    const tokenWallet = formatUnits(await tokenContract.balanceOf(walletB58).call(), tokenDecimals);
    table.push({ Type: "🏦", Address: walletHex, TRX: trxWallet, [ERC20_SYMBOL]: tokenWallet });

    const depB58 = tronWeb.defaultAddress.base58;
    const trxDeployer = TronWeb.fromSun(await tronWeb.trx.getBalance(depB58));
    const tokenDeployer = formatUnits(await tokenContract.balanceOf(depB58).call(), tokenDecimals);
    table.push({ Type: "‍💻", Address: tronWeb.defaultAddress.hex, TRX: trxDeployer, [ERC20_SYMBOL]: tokenDeployer });

    console.table(table);
  }

  async function executeOps(wallet, calls, signature) {
    const tupleCalls = calls.map((c) => [
      toHex41(c.to), // address for Tron ABI: "41..." without "0x"
      BigInt(c.value).toString(), // uint256 as string
      c.data, // bytes
    ]);
    const tupleOps = [[tupleCalls, signature, `0x${"00".repeat(32)}`]];

    return await wallet.execute(tupleOps).send({ feeLimit: TRON_FEE_LIMIT });
  }

  /**
   * Wait until receipt.result === 'SUCCESS'
   * @param {TronWeb} tronWeb
   * @param {string} txId
   * @param {number} timeoutMs
   * @param {number} intervalMs
   * @returns {Promise<{ result: string }>}
   */
  async function waitTxInfo(tronWeb, txId, timeoutMs = 360000, intervalMs = 10000) {
    const start = Date.now();
    // Accept object or string; extract transaction ID
    const id = typeof txId === "string" ? txId : txId?.txID || txId?.txid || txId?.id;

    while (Date.now() - start < timeoutMs) {
      const info = await tronWeb.trx.getTransactionInfo(id);

      if (info?.receipt && typeof info.receipt.result === "string") {
        if (info.receipt.result === "SUCCESS") {
          return info;
        }
        if (info.receipt.result === "REVERT") {
          throw new Error(`Transaction #${id} REVERT`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Transaction #${id} not confirmed with SUCCESS within ${timeoutMs}ms`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
