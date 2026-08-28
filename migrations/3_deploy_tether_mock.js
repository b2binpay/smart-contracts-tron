const TetherToken = artifacts.require("TetherToken");

const USDT_NAME = "Tether USD (Mock)";
const USDT_SYMBOL = "USDTM";
const USDT_DECIMALS = 6;
const ONE_USDT = 10n ** BigInt(USDT_DECIMALS);
const USDT_SUPPLY = 1_000_000n * ONE_USDT;

const MAINNET_NETWORK = "mainnet";

/**
 * Deploys the `TetherToken` mock — the TRON USDT port whose `transfer` moves the funds and
 * returns `false` — so QA and integration tests can drive the claim path against mainnet
 * USDT behaviour. The whole supply lands on the deployer, who hands it out with `transfer`
 * and mints more with `issue`.
 *
 * The name and symbol carry a mock marker so the token is never mistaken for real USDT in
 * wallets and explorers, while the behavioural parameters — 6 decimals and the dormant fee
 * mechanism — stay mainnet-faithful, since those are what reproduce the bug.
 *
 * Test networks only: mainnet is skipped. The deployed instance is verified before the
 * migration completes — mainnet parameters, a dormant fee mechanism, and a simulated
 * `transfer` that decodes to `false`.
 */
module.exports = async (deployer, network) => {
  if (network === MAINNET_NETWORK) {
    console.log("Skipping the USDT mock: test networks only");
    return;
  }

  await deployer.deploy(TetherToken, USDT_SUPPLY.toString(), USDT_NAME, USDT_SYMBOL, USDT_DECIMALS);

  const addressBase58 = toBase58(TetherToken.address);
  const usdt = await tronWeb.contract(TetherToken.abi, addressBase58);

  // The constructor credits the caller, so the owner is the account holding the supply —
  // on a local node tronbox deploys from the node's own account, not from DEPLOYER_PRIVATE_KEY.
  const owner = toBase58(await usdt.owner().call());

  const [name, symbol, decimals, totalSupply, ownerBalance, paused, deprecated, basisPointsRate, maximumFee] =
    await Promise.all([
      usdt.name().call(),
      usdt.symbol().call(),
      usdt.decimals().call(),
      usdt.totalSupply().call(),
      usdt.balanceOf(owner).call(),
      usdt.paused().call(),
      usdt.deprecated().call(),
      usdt.basisPointsRate().call(),
      usdt.maximumFee().call(),
    ]);

  assertEqual(name, USDT_NAME, "name carries the mock marker");
  assertEqual(symbol, USDT_SYMBOL, "symbol carries the mock marker");
  assertEqual(Number(decimals), USDT_DECIMALS, "decimals match mainnet USDT");
  assertEqual(BigInt(totalSupply), USDT_SUPPLY, "total supply is the requested amount");
  assertEqual(BigInt(ownerBalance), USDT_SUPPLY, "the whole supply is on the owner");
  assertEqual(paused, false, "token is not paused");
  assertEqual(deprecated, false, "token is not deprecated");
  assertEqual(BigInt(basisPointsRate), 0n, "fee rate is dormant, as on mainnet");
  assertEqual(BigInt(maximumFee), 0n, "maximum fee is dormant, as on mainnet");

  // Simulated from the owner: a sender without balance would revert on SafeMath instead of returning `false`
  const simulated = await tronWeb.transactionBuilder.triggerConstantContract(
    tronWeb.address.toHex(addressBase58),
    "transfer(address,uint256)",
    {},
    [
      { type: "address", value: owner },
      { type: "uint256", value: ONE_USDT.toString() },
    ],
    owner,
  );
  assertEqual(
    BigInt(`0x${simulated.constant_result[0]}`),
    0n,
    "simulated transfer returns `false` — the mainnet quirk this mock reproduces",
  );

  console.log(`\nMock USDT is ready on '${network}':`);
  console.log(`  address:  ${addressBase58}`);
  console.log(`  supply:   ${USDT_SUPPLY / ONE_USDT} ${symbol} held by ${owner}`);
  console.log("  transfer: returns `false` on success — mainnet USDT behaviour reproduced");
};

function toBase58(address) {
  return address.startsWith("T") ? address : tronWeb.address.fromHex(address);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`USDT mock check failed — ${what}: expected ${expected}, got ${actual}`);
  }
}
