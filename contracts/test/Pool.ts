import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import {
  ConfidentialTestUSD,
  ConfidentialTestUSD__factory,
  Pool,
  Pool__factory,
  TestUSD,
  TestUSD__factory,
} from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { ContractTransactionReceipt } from "ethers";

async function claimWrapAndDeposit(
  token: TestUSD,
  wrapper: ConfidentialTestUSD,
  wrapperAddress: string,
  poolAddress: string,
  depositor: HardhatEthersSigner,
  amount: bigint,
): Promise<ContractTransactionReceipt | null> {
  await (await token.connect(depositor).claim()).wait();
  await (await token.connect(depositor).approve(wrapperAddress, amount)).wait();
  await (await wrapper.connect(depositor).wrap(depositor.address, amount)).wait();

  const encryptedAmount = await fhevm.createEncryptedInput(wrapperAddress, depositor.address).add64(amount).encrypt();

  const tx = await wrapper
    .connect(depositor)
    ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      poolAddress,
      encryptedAmount.handles[0],
      encryptedAmount.inputProof,
      "0x",
    );
  return tx.wait();
}

describe("Pool", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let token: TestUSD;
  let tokenAddress: string;
  let wrapper: ConfidentialTestUSD;
  let wrapperAddress: string;
  let pool: Pool;
  let poolAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    alice = signers[1];
    bob = signers[2];
  });

  beforeEach(async function () {
    // Check whether the tests are running against an FHEVM mock environment
    if (!fhevm.isMock) {
      console.warn(`This hardhat test suite cannot run on Sepolia Testnet`);
      this.skip();
    }

    const tokenFactory = (await ethers.getContractFactory("TestUSD")) as TestUSD__factory;
    token = (await tokenFactory.deploy()) as TestUSD;
    tokenAddress = await token.getAddress();

    const wrapperFactory = (await ethers.getContractFactory("ConfidentialTestUSD")) as ConfidentialTestUSD__factory;
    wrapper = (await wrapperFactory.deploy(tokenAddress)) as ConfidentialTestUSD;
    wrapperAddress = await wrapper.getAddress();

    const poolFactory = (await ethers.getContractFactory("Pool")) as Pool__factory;
    pool = (await poolFactory.deploy(wrapperAddress)) as Pool;
    poolAddress = await pool.getAddress();
  });

  it("credits the depositor's encrypted pool balance with exactly the deposited amount", async function () {
    const depositAmount = 400_000_000n; // 400 ctUSD

    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, depositAmount);

    expect(await pool.depositorCount()).to.eq(1n);
    expect(await pool.depositorAt(0)).to.eq(alice.address);

    const encryptedBalance = await pool.balanceOf(alice.address);
    const clearBalance = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedBalance, poolAddress, alice);

    expect(clearBalance).to.eq(depositAmount);
  });

  it("gives two depositors correct independent balances, and neither can decrypt the other's", async function () {
    const aliceAmount = 250_000_000n;
    const bobAmount = 175_000_000n;

    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, aliceAmount);
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, bob, bobAmount);

    expect(await pool.depositorCount()).to.eq(2n);

    const aliceEncryptedBalance = await pool.balanceOf(alice.address);
    const bobEncryptedBalance = await pool.balanceOf(bob.address);

    const aliceClearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      aliceEncryptedBalance,
      poolAddress,
      alice,
    );
    const bobClearBalance = await fhevm.userDecryptEuint(FhevmType.euint64, bobEncryptedBalance, poolAddress, bob);

    expect(aliceClearBalance).to.eq(aliceAmount);
    expect(bobClearBalance).to.eq(bobAmount);

    let bobDecryptedAlice = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, aliceEncryptedBalance, poolAddress, bob);
      bobDecryptedAlice = true;
    } catch {
      bobDecryptedAlice = false;
    }
    expect(bobDecryptedAlice, "bob must not be able to decrypt alice's pool balance").to.eq(false);
  });

  it("returns exactly the principal and zeroes the balance on a full withdraw", async function () {
    const depositAmount = 500_000_000n;

    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, depositAmount);

    const encryptedWithdraw = await fhevm
      .createEncryptedInput(poolAddress, alice.address)
      .add64(depositAmount)
      .encrypt();
    await (await pool.connect(alice).withdraw(encryptedWithdraw.handles[0], encryptedWithdraw.inputProof)).wait();

    const clearPoolBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice,
    );
    expect(clearPoolBalance).to.eq(0n);

    const clearWalletBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(alice.address),
      wrapperAddress,
      alice,
    );
    expect(clearWalletBalance).to.eq(depositAmount);
  });

  it("leaves the exact remainder on a partial withdraw", async function () {
    const depositAmount = 600_000_000n;
    const withdrawAmount = 220_000_000n;

    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, depositAmount);

    const encryptedWithdraw = await fhevm
      .createEncryptedInput(poolAddress, alice.address)
      .add64(withdrawAmount)
      .encrypt();
    await (await pool.connect(alice).withdraw(encryptedWithdraw.handles[0], encryptedWithdraw.inputProof)).wait();

    const clearPoolBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice,
    );
    expect(clearPoolBalance).to.eq(depositAmount - withdrawAmount);
  });

  it("clamps an over-withdraw to the available balance instead of reverting", async function () {
    const depositAmount = 300_000_000n;
    const requestedAmount = 1_000_000_000n;

    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, depositAmount);

    const encryptedWithdraw = await fhevm
      .createEncryptedInput(poolAddress, alice.address)
      .add64(requestedAmount)
      .encrypt();

    await expect(pool.connect(alice).withdraw(encryptedWithdraw.handles[0], encryptedWithdraw.inputProof)).to.not.be
      .reverted;

    const clearPoolBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice,
    );
    expect(clearPoolBalance).to.eq(0n);

    const clearWalletBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(alice.address),
      wrapperAddress,
      alice,
    );
    // Only the balance (300) is ever sent back, never the requested amount (1,000).
    expect(clearWalletBalance).to.eq(depositAmount);
    expect(clearWalletBalance).to.not.eq(requestedAmount);
  });

  it("keeps the pool's ctUSD custody balance equal to the sum of depositor balances after mixed activity", async function () {
    const aliceDeposit = 400_000_000n;
    const bobDeposit = 350_000_000n;
    const aliceWithdraw = 150_000_000n;
    const bobOverWithdraw = 10_000_000_000n; // far exceeds bob's balance; should clamp

    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, aliceDeposit);
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, bob, bobDeposit);

    const encryptedAliceWithdraw = await fhevm
      .createEncryptedInput(poolAddress, alice.address)
      .add64(aliceWithdraw)
      .encrypt();
    await (
      await pool.connect(alice).withdraw(encryptedAliceWithdraw.handles[0], encryptedAliceWithdraw.inputProof)
    ).wait();

    const encryptedBobWithdraw = await fhevm
      .createEncryptedInput(poolAddress, bob.address)
      .add64(bobOverWithdraw)
      .encrypt();
    await (
      await pool.connect(bob).withdraw(encryptedBobWithdraw.handles[0], encryptedBobWithdraw.inputProof)
    ).wait();

    const aliceExpectedBalance = aliceDeposit - aliceWithdraw;
    const bobExpectedBalance = 0n; // fully clamped out by the over-withdraw

    const aliceClearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(alice.address),
      poolAddress,
      alice,
    );
    const bobClearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceOf(bob.address),
      poolAddress,
      bob,
    );
    expect(aliceClearBalance).to.eq(aliceExpectedBalance);
    expect(bobClearBalance).to.eq(bobExpectedBalance);

    const sumOfDepositorBalances = aliceClearBalance + bobClearBalance;

    // The pool's own ctUSD custody balance is not ACL-granted to any single depositor,
    // so it cannot be user-decrypted by one of them; the mock debug decrypt is the
    // legitimate way to read this internal, no-single-owner aggregate value in a test.
    const poolCtUsdHandle = await wrapper.confidentialBalanceOf(poolAddress);
    const poolCtUsdClearBalance = await fhevm.debugger.decryptEuint(FhevmType.euint64, poolCtUsdHandle);

    expect(poolCtUsdClearBalance).to.eq(sumOfDepositorBalances);
  });

  it("never reveals a plaintext deposit amount in any emitted event", async function () {
    const depositAmount = 777_000_000n;
    const receipt = await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, depositAmount);
    expect(receipt).to.not.eq(null);

    const poolInterface = pool.interface;
    const wrapperInterface = wrapper.interface;

    let inspectedAtLeastOneEvent = false;

    for (const log of receipt!.logs) {
      let parsed = poolInterface.parseLog(log);
      if (parsed === null) {
        parsed = wrapperInterface.parseLog(log);
      }
      if (parsed === null) continue;

      inspectedAtLeastOneEvent = true;

      for (const arg of parsed.args) {
        // Encrypted handles are decoded by ethers as bytes32 hex strings, never as
        // bigint. Any bigint argument would indicate a plaintext numeric value leaked
        // in an event.
        if (typeof arg === "bigint") {
          expect(arg).to.not.eq(depositAmount);
        }
      }
    }

    expect(inspectedAtLeastOneEvent, "expected at least one Pool/wrapper event to inspect").to.eq(true);
  });
});
