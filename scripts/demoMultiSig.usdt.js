/**
 * Assertion-driven port of the EVM `demoMultiSig.usdt.ts` demo for a TVM node,
 * adapted to the minimal SafeTRC20-style library: only the low-level call success
 * is checked, the returndata is ignored entirely.
 *
 * Exercises the returndata matrix through the production claim path
 * (MultiSigWalletStaking implementation -> ERC-1167 clone -> CREATE2 DepositAccount sweep):
 *
 * - TetherToken (TRON USDT port, mainnet parameters: 6 decimals, zero fees) — `transfer`
 *   returns `false` on success; the minimal library never reads it, so USDT claims pass;
 * - ERC20ReturnDataMock — every other returndata shape combined with a balance effect;
 *   PART 2 asserts the silent outcome of each case.
 *
 * Every step is asserted; the script exits with a non-zero code on the first violation.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { TronWeb } = require("tronweb");
const {
  Interface,
  keccak256,
  solidityPackedKeccak256,
  getBytes,
  recoverAddress,
  formatUnits,
  parseUnits,
  Wallet,
  TypedDataEncoder,
} = require("ethers");

const { DEPOSITS, TRON_FEE_LIMIT, PERMISSION_CLAIM } = require("./utils/constants");

const SOLC_TARGET = process.env.SOLC_TARGET || "0.8.25";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_ID = `0x${"00".repeat(32)}`;

const PROVIDER_URI = process.env.PROVIDER_URI || "http://127.0.0.1:9090";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(__dirname, `../build/${SOLC_TARGET}/contracts`);

const USDT_NAME = "Tether USD (Mock)";
const USDT_SYMBOL = "USDTM";
const USDT_DECIMALS = 6;
const USDT_INITIAL_SUPPLY = parseUnits("1000", USDT_DECIMALS);

const MOCK_SYMBOL = "MOCK";
const MOCK_DECIMALS = 18;
const MOCK_VALUE = parseUnits("10", MOCK_DECIMALS);

const ReturnMode = { True: 0, Empty: 1, False: 2, Two: 3, Short: 4, Long: 5 };
const TransferEffect = { Full: 0, Partial: 1, None: 2, Credit: 3 };

/** Balance deltas produced by ERC20ReturnDataMock.transfer for each TransferEffect, as functions of the claimed value. */
const TRANSFER_EFFECT_DELTAS = {
  [TransferEffect.Full]: { deposit: (value) => -value, wallet: (value) => value },
  [TransferEffect.Partial]: { deposit: (value) => -(value / 2n), wallet: (value) => value / 2n },
  [TransferEffect.None]: { deposit: () => 0n, wallet: () => 0n },
  [TransferEffect.Credit]: { deposit: (value) => value, wallet: () => 0n },
};

const parseUsdt = (value) => parseUnits(value, USDT_DECIMALS);

const tronWeb = new TronWeb(PROVIDER_URI, PROVIDER_URI, PROVIDER_URI, PRIVATE_KEY);

let passedChecks = 0;

async function main() {
  // ---------- Load artifacts ----------
  const ProxyFactory = readArtifact("ProxyFactory");
  const MultiSigWalletStaking = readArtifact("MultiSigWalletStaking");
  const DepositAccount = readArtifact("DepositAccount");
  const TetherToken = readArtifact("TetherToken");
  const ERC20ReturnDataMock = readArtifact("ERC20ReturnDataMock");

  const walletInterface = new Interface(MultiSigWalletStaking.abi);

  // ---------- Generate owners ----------
  const owner1 = await TronWeb.createAccount();
  const owner2 = await TronWeb.createAccount();

  const ownersBase58 = [owner1.address.base58, owner2.address.base58];
  const owners = ownersBase58.map((a) => tronWeb.address.toHex(a)); // 41...
  const threshold = 1;

  const deployerAddress = tronWeb.defaultAddress.base58;

  console.log(`╭ Deployer: ${deployerAddress} (${TronWeb.fromSun(await tronWeb.trx.getBalance(deployerAddress))} TRX)`);
  console.log(`| Owner #1: ${ownersBase58[0]}`);
  console.log(`| Owner #2: ${ownersBase58[1]}`);
  console.log(`╰     Solc: ${SOLC_TARGET}`);

  /**
   * TetherToken (TRON USDT port) with mainnet parameters
   */
  const usdtDeploy = await tronWeb.contract().new({
    abi: TetherToken.abi,
    bytecode: TetherToken.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [USDT_INITIAL_SUPPLY.toString(), USDT_NAME, USDT_SYMBOL, USDT_DECIMALS],
  });
  const usdt = await tronWeb.contract(TetherToken.abi, toB58(usdtDeploy.address));
  const usdtColumn = { symbol: USDT_SYMBOL, contract: usdt, decimals: USDT_DECIMALS };
  console.log(`\n┏ 'TetherToken' \n┗ ${usdtDeploy.address} [${toB58(usdtDeploy.address)}]`);

  expectEq(await usdt.name().call(), USDT_NAME, "USDT name carries the mock marker");
  expectEq(await usdt.symbol().call(), USDT_SYMBOL, "USDT symbol carries the mock marker");
  expectEq(BigInt(await usdt.decimals().call()), BigInt(USDT_DECIMALS), "USDT decimals match mainnet (6)");
  expectEq(BigInt(await usdt.totalSupply().call()), USDT_INITIAL_SUPPLY, "USDT total supply is 1000");
  expectEq(await usdtBalance(deployerAddress), USDT_INITIAL_SUPPLY, "deployer holds the full supply");

  // The defining USDT quirk: a simulated transfer decodes to `false` even though it moves funds
  const simulated = await tronWeb.transactionBuilder.triggerConstantContract(
    toHex41(usdtDeploy.address),
    "transfer(address,uint256)",
    {},
    [
      { type: "address", value: ownersBase58[0] },
      { type: "uint256", value: parseUsdt("10").toString() },
    ],
    deployerAddress,
  );
  expectEq(BigInt(`0x${simulated.constant_result[0]}`), 0n, "simulated USDT transfer returns `false`");

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
   * MultiSigWalletStaking (master copy / implementation) — the contract deployed on TRON
   */
  const implementation = await tronWeb.contract().new({
    abi: MultiSigWalletStaking.abi,
    bytecode: MultiSigWalletStaking.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [],
  });
  console.log(
    `\n┏ 'MultiSigWalletStaking' implementation (master copy) \n┗ ${implementation.address} [${toB58(implementation.address)}]`,
  );

  /**
   * Wallet clone via CREATE2 (off-chain address cross-checked against computeAddress)
   */
  const initializer = encodeSetup(owners, threshold);

  const implementationHex = toHex20(implementation.address);
  const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementationHex.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const cloneBytecodeHash = keccak256(getBytes(cloneBytecode));

  const walletSalt = solidityPackedKeccak256(
    ["bytes32", "bytes32"],
    [keccak256(getBytes(initializer)), DEPOSITS[0].id],
  );
  const offchainWallet = computeCreate2AddressTVM(proxy.address, walletSalt, cloneBytecodeHash);

  const computed = await proxy.computeAddress(implementation.address, initializer, DEPOSITS[0].id).call();
  const walletHex = computed.instance || computed["1"] || computed[1];

  expectEq(walletHex.toLowerCase(), offchainWallet.toLowerCase(), "wallet CREATE2 address matches (0x41 prefix)");

  console.log(`\n╭ Create wallet with ID [${DEPOSITS[0].id}] (owners: ${owners.length}, threshold: ${threshold}) |`);
  const createTx = await proxy
    .createInstance(implementation.address, initializer, DEPOSITS[0].id)
    .send({ feeLimit: TRON_FEE_LIMIT });
  await expectSuccess(createTx, "createInstance succeeds");

  const wallet = await tronWeb.contract(MultiSigWalletStaking.abi, toB58(walletHex));
  console.log(`\n┏ 'MultiSigWalletStaking' clone \n┗ ${walletHex} [${toB58(walletHex)}]`);
  console.log("  ┣ Version  :", await wallet.version().call());
  console.log("  ┣ Threshold:", (await wallet.threshold().call()).toString());
  console.log("  ┗ Owners   :", await wallet.owners().call());

  /**
   * Deposit accounts (off-chain CREATE2 cross-checked against getAccounts)
   */
  const depositIds = [DEPOSITS[0].id, DEPOSITS[1].id];
  const depositBytecodeHash = keccak256(getBytes(DepositAccount.bytecode));

  const retAcc = await wallet.getAccounts(depositIds).call();
  const deposits = retAcc.accounts || retAcc["1"] || retAcc[1];

  for (const [i, id] of depositIds.entries()) {
    const offchain = computeCreate2AddressTVM(walletHex, id, depositBytecodeHash);
    expectEq(deposits[i].toLowerCase(), offchain.toLowerCase(), `deposit #${i} CREATE2 address matches (0x41 prefix)`);
  }

  /**
   * Grant the deployer `PERMISSION_CLAIM` and read it back off the permission index
   */
  console.log("\n╭ Grant the deployer the claim permission |");
  {
    const data = encodeUpdatePermissions([toHex20(tronWeb.defaultAddress.hex)], [PERMISSION_CLAIM], [0n]);
    const calls = [{ to: walletHex, value: 0n, data }];

    const { digest, signature } = await signExecuteCalls(walletHex, calls, owner1.privateKey);
    const tx = await executeOps(calls, packSignatures(digest, [signature]));
    await expectSuccess(tx, "updatePermissions execute succeeds");

    // TronWeb may hand a multi-output call back as a positional tuple rather than by output name.
    const entries = await wallet.permissions().call();
    const accounts = entries.accounts || entries[0];
    const masks = entries.masks || entries[1];

    const claimHolders = accounts
      .filter((_, i) => (BigInt(masks[i]) & PERMISSION_CLAIM) !== 0n)
      .map((a) => toHex41(a).toLowerCase());

    expectEq(
      claimHolders.includes(toHex41(tronWeb.defaultAddress.hex).toLowerCase()),
      true,
      "deployer holds the claim permission",
    );
  }

  /**
   * PART 1 — TRON USDT claims through the `false`-on-success path
   */
  console.log("\n| PART 1: TetherToken (USDT) claims |");

  console.log("\n╭ Fund 0.01 TRX & 10 USDT to deposit #0 (twice) |");
  await fundUsdt(deposits[0], "10");
  await fundTrx(deposits[0], "0.01");
  await fundUsdt(deposits[0], "10");
  await fundTrx(deposits[0], "0.01");

  expectEq(
    await usdtBalance(deposits[0]),
    parseUsdt("20"),
    "deposit #0 funded with 20 USDT (real transfers moved funds)",
  );
  expectEq(await trxBalance(deposits[0]), parseSun("0.02"), "deposit #0 funded with 0.02 TRX");
  await assertUsdtSupplyInvariant([deposits[0], deposits[1]], walletHex);

  await printBalances("Balances after funding, before claims", [deposits[0], deposits[1]], walletHex, [usdtColumn]);

  console.log("\n╭ Claim only TRX from deposit #0 |");
  {
    const tx = await wallet.claim(ZERO_ADDRESS, [depositIds[0]]).send({ feeLimit: TRON_FEE_LIMIT });
    await expectSuccess(tx, "native TRX claim succeeds");
    expectEq(await trxBalance(deposits[0]), 0n, "deposit #0 TRX swept");
    expectEq(await trxBalance(walletHex), parseSun("0.02"), "wallet received 0.02 TRX");
    expectEq(await usdtBalance(deposits[0]), parseUsdt("20"), "deposit #0 USDT untouched by the TRX claim");
  }

  console.log("\n╭ Claim USDT from deposit #0 (transfer returns `false`, returndata is ignored) |");
  {
    const tx = await wallet.claim(usdtDeploy.address, [depositIds[0]]).send({ feeLimit: TRON_FEE_LIMIT });
    await expectSuccess(tx, "USDT claim succeeds despite `false` return");
    expectEq(await usdtBalance(deposits[0]), 0n, "deposit #0 USDT swept");
    expectEq(await usdtBalance(walletHex), parseUsdt("20"), "wallet received 20 USDT");
    await assertUsdtSupplyInvariant([deposits[0], deposits[1]], walletHex);
  }

  console.log("\n╭ Batch claim USDT (+TRX sweep) from deposits #0 & #1 |");
  {
    await fundUsdt(deposits[0], "10");
    await fundTrx(deposits[0], "0.01");
    await fundUsdt(deposits[1], "10");
    await fundTrx(deposits[1], "0.01");

    const tx = await wallet.claim(usdtDeploy.address, depositIds).send({ feeLimit: TRON_FEE_LIMIT });
    await expectSuccess(tx, "batch USDT claim succeeds");
    expectEq(await usdtBalance(deposits[0]), 0n, "deposit #0 USDT swept by batch claim");
    expectEq(await usdtBalance(deposits[1]), 0n, "deposit #1 USDT swept by batch claim");
    expectEq(await usdtBalance(walletHex), parseUsdt("40"), "wallet holds 40 USDT after batch claim");
    expectEq(await trxBalance(walletHex), parseSun("0.04"), "wallet holds 0.04 TRX after batch claim");
    await assertUsdtSupplyInvariant([deposits[0], deposits[1]], walletHex);
  }

  await printBalances("Balances after Part 1 claims", [deposits[0], deposits[1]], walletHex, [usdtColumn]);

  /**
   * PART 2 — returndata matrix through ERC20ReturnDataMock
   * (deposit #0 address is reused: DepositAccount self-destructs after every successful claim,
   * and with the minimal library EVERY non-reverting claim is "successful").
   */
  console.log("\n| PART 2: ERC20ReturnDataMock — what the minimal library accepts silently |");

  const mockDeploy = await tronWeb.contract().new({
    abi: ERC20ReturnDataMock.abi,
    bytecode: ERC20ReturnDataMock.bytecode,
    feeLimit: TRON_FEE_LIMIT,
    callValue: 0,
    parameters: [],
  });
  const mock = await tronWeb.contract(ERC20ReturnDataMock.abi, toB58(mockDeploy.address));
  const mockColumn = { symbol: MOCK_SYMBOL, contract: mock, decimals: MOCK_DECIMALS };
  console.log(`\n┏ 'ERC20ReturnDataMock' \n┗ ${mockDeploy.address} [${toB58(mockDeploy.address)}]`);

  /**
   * Every case ends with a SUCCESS claim and a Claim event carrying the full pre-claim
   * balance — the number the backend would credit. The balance assertions then pin what
   * the token actually did, and the delta between the two is the silent shortfall.
   */
  const silentCases = [
    {
      label: "`false` without a balance change",
      outcome: "nothing moves",
      mode: ReturnMode.False,
      effect: TransferEffect.None,
    },
    {
      label: "`false` with a partial debit",
      outcome: "half moves",
      mode: ReturnMode.False,
      effect: TransferEffect.Partial,
    },
    {
      label: "`false` with a credit instead of a debit",
      outcome: "deposit grows",
      mode: ReturnMode.False,
      effect: TransferEffect.Credit,
    },
    {
      label: "non-boolean word (2) with a full debit",
      outcome: "funds move, accepted by luck",
      mode: ReturnMode.Two,
      effect: TransferEffect.Full,
    },
    {
      label: "returndata shorter than 32 bytes with a full debit",
      outcome: "funds move, accepted by luck",
      mode: ReturnMode.Short,
      effect: TransferEffect.Full,
    },
    {
      label: "returndata longer than 32 bytes with a `true` first word",
      outcome: "funds move, `true` first word",
      mode: ReturnMode.Long,
      effect: TransferEffect.Full,
    },
    {
      label: "`false` with a full debit (generic false-on-success)",
      outcome: "funds move, no proof read",
      mode: ReturnMode.False,
      effect: TransferEffect.Full,
    },
  ];

  for (const { label, outcome, mode, effect } of silentCases) {
    console.log(`\n╭ Claim succeeds (${outcome}): ${label} |`);
    const mintTx = await mock.mint(toB58(deposits[0]), MOCK_VALUE.toString()).send({ feeLimit: TRON_FEE_LIMIT });
    await expectSuccess(mintTx, "mint 10 MOCK to deposit #0");
    await setMockBehavior(mock, mode, effect);

    const [depositBefore, walletBefore] = await Promise.all([
      mockBalance(mock, deposits[0]),
      mockBalance(mock, walletHex),
    ]);

    const tx = await wallet.claim(mockDeploy.address, [depositIds[0]]).send({ feeLimit: TRON_FEE_LIMIT });
    const info = await expectSuccess(tx, `claim succeeds: ${label}`);

    const deltas = TRANSFER_EFFECT_DELTAS[effect];
    const movedToWallet = deltas.wallet(depositBefore);
    const [depositAfter, walletAfter] = await Promise.all([
      mockBalance(mock, deposits[0]),
      mockBalance(mock, walletHex),
    ]);

    expectEq(claimedTokenAmount(info), depositBefore, "Claim event reports the full pre-claim balance");
    expectEq(
      depositAfter,
      depositBefore + deltas.deposit(depositBefore),
      "deposit balance matches the token's real effect",
    );
    expectEq(walletAfter, walletBefore + movedToWallet, "wallet received only what the token really moved");

    const shortfall = depositBefore - movedToWallet;
    if (shortfall > 0n) {
      console.log(
        `  ⚠ accounting credits ${formatUnits(depositBefore, MOCK_DECIMALS)} MOCK, ` +
          `chain moved ${formatUnits(movedToWallet, MOCK_DECIMALS)} — ` +
          `silent shortfall ${formatUnits(shortfall, MOCK_DECIMALS)} MOCK`,
      );
    }
  }

  /**
   * Spending USDT from the wallet: execute does not decode ERC20 returndata
   * (Address.functionCallWithValue checks only call success), so the `false`
   * return does not block direct transfers.
   */
  console.log("\n╭ Execute: return 40 USDT to the deployer |");
  {
    const data = encodeErc20Transfer(toHex20(deployerAddress), parseUsdt("40"));
    const calls = [{ to: toHex41(usdtDeploy.address), value: 0n, data }];

    const { digest, signature } = await signExecuteCalls(walletHex, calls, owner1.privateKey);
    const tx = await executeOps(calls, packSignatures(digest, [signature]));
    await expectSuccess(tx, "execute returns 40 USDT to the deployer");

    expectEq(await usdtBalance(walletHex), 0n, "wallet USDT drained");
    expectEq(await usdtBalance(deployerAddress), USDT_INITIAL_SUPPLY, "deployer holds the full supply again");
  }

  await printBalances("Final balances", [deposits[0], deposits[1]], walletHex, [usdtColumn, mockColumn]);

  console.log(`\n✔ ALL ${passedChecks} ASSERTIONS PASSED`);

  /**
   * Balance & funding helpers
   */

  async function usdtBalance(address) {
    return BigInt(await usdt.balanceOf(toB58(address)).call());
  }

  async function mockBalance(mockContract, address) {
    return BigInt(await mockContract.balanceOf(toB58(address)).call());
  }

  async function trxBalance(address) {
    return BigInt(await tronWeb.trx.getBalance(toB58(address)));
  }

  async function fundUsdt(toHex41Addr, amount) {
    const tx = await usdt.transfer(toB58(toHex41Addr), parseUsdt(amount).toString()).send({ feeLimit: TRON_FEE_LIMIT });
    await expectSuccess(tx, `fund ${amount} USDT to ${toB58(toHex41Addr)}`);
  }

  async function fundTrx(toHex41Addr, amount) {
    const before = await trxBalance(toHex41Addr);
    const tx = await tronWeb.trx.sendTransaction(toB58(toHex41Addr), Number(parseSun(amount)));
    await expectSuccess(tx.txid || tx.transaction?.txID, `fund ${amount} TRX to ${toB58(toHex41Addr)}`);
    expectEq(await trxBalance(toHex41Addr), before + parseSun(amount), `TRX balance increased by ${amount}`);
  }

  async function setMockBehavior(mockContract, mode, effect) {
    const tx = await mockContract.setBehavior(mode, effect).send({ feeLimit: TRON_FEE_LIMIT });
    await expectSuccess(tx, `setBehavior(mode=${mode}, effect=${effect})`);
  }

  /**
   * The USDT supply never changes: the deployer, the wallet, and the deposit accounts
   * are the only holders in this demo.
   */
  async function assertUsdtSupplyInvariant(depositAddrs, walletAddr) {
    let sum = await usdtBalance(deployerAddress);
    sum += await usdtBalance(walletAddr);
    for (const dep of depositAddrs) {
      sum += await usdtBalance(dep);
    }
    expectEq(sum, USDT_INITIAL_SUPPLY, "USDT supply invariant holds (sum of holders = 1000)");
  }

  async function printBalances(label, depositAddrs, walletAddr, tokens) {
    const holders = [
      ...depositAddrs.map((addr) => ({ Type: "💰", Address: addr })),
      { Type: "🏦", Address: walletAddr },
      { Type: "‍💻", Address: tronWeb.defaultAddress.hex },
    ];

    const table = [];
    for (const { Type, Address } of holders) {
      const row = { Type, Address, TRX: TronWeb.fromSun(Number(await trxBalance(Address))) };
      for (const { symbol, contract, decimals } of tokens) {
        row[symbol] = formatUnits(BigInt(await contract.balanceOf(toB58(Address)).call()), decimals);
      }
      table.push(row);
    }

    console.log(`\n╭ ${label} |`);
    console.table(table);
  }

  /**
   * Multisig helpers (same shape as demoMultiSig.js)
   */

  function encodeSetup(owners_, threshold_) {
    const ownersHex = toHex20(owners_);
    const selector = tronWeb.sha3("setup(address[],uint256)").slice(0, 10);
    const encoded = tronWeb.utils.abi.encodeParams(["address[]", "uint256"], [ownersHex, String(threshold_)]);
    return selector + encoded.slice(2);
  }

  function encodeUpdatePermissions(accounts, grants, revokes) {
    const selector = tronWeb.sha3("updatePermissions(address[],uint256[],uint256[])").slice(0, 10);
    const encoded = tronWeb.utils.abi.encodeParams(
      ["address[]", "uint256[]", "uint256[]"],
      [accounts, grants.map(String), revokes.map(String)],
    );
    return selector + encoded.slice(2);
  }

  function encodeErc20Transfer(to, value) {
    const selector = tronWeb.sha3("transfer(address,uint256)").slice(0, 10);
    const encoded = tronWeb.utils.abi.encodeParams(["address", "uint256"], [to, value.toString()]);
    return selector + encoded.slice(2);
  }

  async function signExecuteCalls(walletHex41, calls, pk) {
    const d = await wallet.eip712Domain().call();
    const domain = {
      name: (d.name || d[1]).toString(),
      version: (d.version || d[2]).toString(),
      chainId: BigInt(d.chainId || d[3]),
      verifyingContract: toHex20(walletHex41),
    };

    const normalizedCalls = calls.map((c) => ({ to: toHex20(c.to), value: BigInt(c.value), data: c.data }));
    const nonce = BigInt(await wallet.nonce().call());

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

  /**
   * Pack ECDSA signatures into the format expected by checkSignatures:
   * [signer:20 bytes][sigLen:2 bytes uint16 BE][sig:sigLen bytes] × N, signers ascending.
   */
  function packSignatures(digest, sigs) {
    const items = sigs.map((s) => ({ signer: recoverAddress(digest, s).toLowerCase(), signature: s }));
    items.sort((a, b) => a.signer.localeCompare(b.signer));

    const parts = items.map(({ signer, signature }) => {
      const sigHex = signature.slice(2);
      const sigLenHex = (sigHex.length / 2).toString(16).padStart(4, "0");
      return `${signer.slice(2)}${sigLenHex}${sigHex}`;
    });

    return `0x${parts.join("")}`;
  }

  async function executeOps(calls, signature) {
    const tupleCalls = calls.map((c) => [toHex41(c.to), BigInt(c.value).toString(), c.data]);
    const tupleOps = [[tupleCalls, signature, ZERO_ID]];

    return await wallet.execute(tupleOps).send({ feeLimit: TRON_FEE_LIMIT });
  }

  /**
   * Assertion & receipt helpers
   */

  function expectEq(actual, expected, label) {
    assert.deepEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
    passedChecks += 1;
    console.log(`  ✓ ${label}`);
  }

  async function expectSuccess(txId, label) {
    const info = await waitTx(txId);
    expectEq(info.receipt.result || "SUCCESS", "SUCCESS", label);
    return info;
  }

  /** `tokenAmount` in the Claim event is the pre-claim deposit balance — the figure the backend would credit. */
  function claimedTokenAmount(info) {
    for (const entry of info.log || []) {
      const parsed = walletInterface.parseLog({
        topics: (entry.topics || []).map(add0x),
        data: add0x(entry.data || ""),
      });
      if (parsed?.name === "Claim") {
        return parsed.args.tokenAmount;
      }
    }
    return assert.fail("Claim event not found in the receipt");
  }

  /** TVM receipts encode log topics and data as unprefixed hex. */
  function add0x(hex) {
    return hex.startsWith("0x") ? hex : `0x${hex}`;
  }

  /** Waits until the transaction has a terminal receipt (SUCCESS, REVERT, ...). */
  async function waitTx(txId, timeoutMs = 120_000, intervalMs = 2_000) {
    const id = typeof txId === "string" ? txId : txId?.txID || txId?.txid || txId?.id;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const info = await tronWeb.trx.getTransactionInfo(id);
      if (info?.receipt) {
        // Plain TRX transfers have a receipt without a `result` field
        if (typeof info.receipt.result !== "string" || info.receipt.result !== "PENDING") {
          return info;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Transaction #${id} not confirmed within ${timeoutMs}ms`);
  }

  /**
   * Address helpers (TVM 0x41 conventions)
   */

  function toB58(hex41) {
    if (typeof hex41 === "string" && hex41.startsWith("T")) {
      return hex41;
    }
    return tronWeb.address.fromHex(hex41);
  }

  function toHex20(addresses) {
    const arr = Array.isArray(addresses) ? addresses : [addresses];
    const out = arr.map((addr) => {
      let hex = addr;
      if (hex.startsWith("T")) {
        hex = tronWeb.address.toHex(hex);
      }
      if (hex.startsWith("0x")) {
        hex = hex.slice(2);
      }
      if (hex.startsWith("41") && hex.length === 42) {
        hex = hex.slice(2);
      }
      return `0x${hex.padStart(40, "0")}`;
    });
    return Array.isArray(addresses) ? out : out[0];
  }

  function toHex41(addr) {
    let hex = addr;
    if (hex.startsWith("T")) {
      hex = tronWeb.address.toHex(hex);
    }
    if (hex.startsWith("0x")) {
      hex = hex.slice(2);
    }
    if (!hex.startsWith("41") || hex.length === 40) {
      hex = `41${hex}`;
    }
    return hex;
  }

  /** TVM CREATE2: keccak256(0x41 ++ deployer(20) ++ salt(32) ++ keccak256(initcode))[12:] */
  function computeCreate2AddressTVM(deployer, salt32, bytecodeHash32) {
    const deployerBytes = getBytes(`0x${toHex41(deployer)}`); // [0x41, <20>]

    const packed = new Uint8Array(1 + 20 + 32 + 32);
    packed.set([0x41], 0);
    packed.set(deployerBytes.slice(1), 1);
    packed.set(getBytes(salt32), 21);
    packed.set(getBytes(bytecodeHash32), 53);

    const hash = keccak256(packed);
    return `41${hash.slice(2 + 24)}`;
  }

  function parseSun(trx) {
    return BigInt(TronWeb.toSun(Number(trx)));
  }
}

function readArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, `${name}.json`), "utf8"));
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("\n✘ DEMO FAILED:", error);
    process.exitCode = 1;
  });
