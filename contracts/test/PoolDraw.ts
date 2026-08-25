import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, fhevm } from "hardhat";
import {
  ConfidentialTestUSD,
  ConfidentialTestUSD__factory,
  Pool,
  Pool__factory,
  ReserveYieldSource,
  ReserveYieldSource__factory,
  TestUSD,
  TestUSD__factory,
} from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

const RATE_SCALE = 10n ** 18n;
const DRAW_INTERVAL = 3600n; // 1 hour
const DRAW_TIMEOUT = 1800n; // 30 minutes
const MAX_CHUNK = 20n; // must match Pool.MAX_CHUNK

const DrawStateIdle = 0n;
const DrawStateRevealing = 1n;
const DrawStateWalking = 2n;

async function claimWrapAndDeposit(
  token: TestUSD,
  wrapper: ConfidentialTestUSD,
  wrapperAddress: string,
  poolAddress: string,
  depositor: HardhatEthersSigner,
  amount: bigint,
): Promise<void> {
  await (await token.connect(depositor).claim()).wait();
  await (await token.connect(depositor).approve(wrapperAddress, amount)).wait();
  await (await wrapper.connect(depositor).wrap(depositor.address, amount)).wait();

  const encryptedAmount = await fhevm.createEncryptedInput(wrapperAddress, depositor.address).add64(amount).encrypt();

  await (
    await wrapper
      .connect(depositor)
      ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
        poolAddress,
        encryptedAmount.handles[0],
        encryptedAmount.inputProof,
        "0x",
      )
  ).wait();
}

/// Funds `count` fresh wallets with ETH and tUSD-claiming ability, for tests that need
/// more depositors than the default Hardhat signer set provides.
async function createFundedDepositors(
  funder: HardhatEthersSigner,
  count: number,
): Promise<HardhatEthersSigner[]> {
  const wallets: HardhatEthersSigner[] = [];
  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider) as unknown as HardhatEthersSigner;
    await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") })).wait();
    wallets.push(wallet);
  }
  return wallets;
}

describe("Pool draw (phase 4b)", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let token: TestUSD;
  let tokenAddress: string;
  let wrapper: ConfidentialTestUSD;
  let wrapperAddress: string;
  let yieldSource: ReserveYieldSource;
  let yieldSourceAddress: string;
  let pool: Pool;
  let poolAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    alice = signers[1];
    bob = signers[2];
    carol = signers[3];
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

    const yieldSourceFactory = (await ethers.getContractFactory(
      "ReserveYieldSource",
    )) as ReserveYieldSource__factory;
    yieldSource = (await yieldSourceFactory.deploy(
      tokenAddress,
      wrapperAddress,
      deployer.address,
    )) as ReserveYieldSource;
    yieldSourceAddress = await yieldSource.getAddress();

    const poolFactory = (await ethers.getContractFactory("Pool")) as Pool__factory;
    pool = (await poolFactory.deploy(wrapperAddress, yieldSourceAddress, DRAW_INTERVAL, DRAW_TIMEOUT)) as Pool;
    poolAddress = await pool.getAddress();

    await (await yieldSource.connect(deployer).setConsumer(poolAddress)).wait();

    await (await token.connect(deployer).claim()).wait();
    await (
      await token.connect(deployer).approve(yieldSourceAddress, await token.FAUCET_AMOUNT())
    ).wait();
    await (await yieldSource.connect(deployer).fund(await token.FAUCET_AMOUNT())).wait();
    // A generous rate: comfortably inside the reserve for the deposit sizes used below,
    // so the draw exercises the real accrual formula rather than the reserve cap.
    await (await yieldSource.connect(deployer).setRate(RATE_SCALE / 10_000n)).wait();
  });

  async function startAndReveal(): Promise<{ clearTotal: bigint; prize: bigint; dart: bigint; zeroTotal: boolean }> {
    await time.increase(DRAW_INTERVAL);

    const startTx = await pool.startDraw();
    const startReceipt = await startTx.wait();
    const drawStarted = startReceipt!.logs
      .map((log) => pool.interface.parseLog(log))
      .find((parsed) => parsed?.name === "DrawStarted");
    expect(drawStarted, "expected a DrawStarted event").to.not.eq(undefined);
    const totalHandle: string = drawStarted!.args.total;

    const decryption = await fhevm.publicDecrypt([totalHandle]);
    const clearTotal = Object.values(decryption.clearValues)[0] as bigint;

    const revealTx = await pool.fulfillReveal(clearTotal, decryption.decryptionProof);
    const revealReceipt = await revealTx.wait();
    const parsedLogs = revealReceipt!.logs.map((log) => pool.interface.parseLog(log));

    const zeroTotalCompletion = parsedLogs.find((parsed) => parsed?.name === "DrawCompleted");
    if (zeroTotalCompletion) {
      return { clearTotal, prize: 0n, dart: 0n, zeroTotal: true };
    }

    const dartDrawn = parsedLogs.find((parsed) => parsed?.name === "DrawDartDrawn");
    const drawRevealed = parsedLogs.find((parsed) => parsed?.name === "DrawRevealed");
    expect(dartDrawn, "expected a DrawDartDrawn event").to.not.eq(undefined);
    expect(drawRevealed, "expected a DrawRevealed event").to.not.eq(undefined);

    const dart = await fhevm.debugger.decryptEuint(FhevmType.euint64, dartDrawn!.args.dart);
    const prize = drawRevealed!.args.prize as bigint;

    return { clearTotal, prize, dart, zeroTotal: false };
  }

  async function advanceUntilIdle(maxSteps: bigint = MAX_CHUNK): Promise<number> {
    let calls = 0;
    while ((await pool.drawState()) !== DrawStateIdle) {
      await (await pool.advanceDraw(maxSteps)).wait();
      calls++;
    }
    return calls;
  }

  async function runFullDraw(): Promise<{ clearTotal: bigint; prize: bigint; dart: bigint }> {
    const { clearTotal, prize, dart, zeroTotal } = await startAndReveal();
    if (!zeroTotal) {
      await advanceUntilIdle();
    }
    return { clearTotal, prize, dart };
  }

  async function expectedWinnerFromDart(
    orderedDepositors: HardhatEthersSigner[],
    preBalances: Map<string, bigint>,
    dart: bigint,
  ): Promise<string | null> {
    let segmentStart = 0n;
    let expectedWinner: string | null = null;
    for (const depositor of orderedDepositors) {
      const balance = preBalances.get(depositor.address)!;
      const segmentEnd = segmentStart + balance;
      if (dart >= segmentStart && dart < segmentEnd) {
        expectedWinner = depositor.address;
      }
      segmentStart = segmentEnd;
    }
    return expectedWinner;
  }

  it("credits exactly the depositor whose segment contains the actual dart, and no one else", async function () {
    const deposits: [HardhatEthersSigner, bigint][] = [
      [alice, 300_000_000n],
      [bob, 500_000_000n],
      [carol, 200_000_000n],
    ];
    for (const [depositor, amount] of deposits) {
      await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, depositor, amount);
    }

    const depositorCount = await pool.depositorCount();
    const orderedDepositors: HardhatEthersSigner[] = [];
    const signerByAddress = new Map([alice, bob, carol].map((s) => [s.address, s]));
    for (let i = 0n; i < depositorCount; i++) {
      const address = await pool.depositorAt(i);
      orderedDepositors.push(signerByAddress.get(address)!);
    }

    const preBalances = new Map<string, bigint>();
    for (const depositor of orderedDepositors) {
      const encrypted = await pool.balanceOf(depositor.address);
      preBalances.set(
        depositor.address,
        await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor),
      );
    }

    const { clearTotal, prize, dart } = await runFullDraw();

    const totalDeposited = deposits.reduce((sum, [, amount]) => sum + amount, 0n);
    expect(clearTotal).to.eq(totalDeposited);
    expect(dart).to.be.gte(0n);
    expect(dart).to.be.lt(clearTotal);

    const expectedWinner = await expectedWinnerFromDart(orderedDepositors, preBalances, dart);
    expect(expectedWinner, "the dart must fall inside exactly one depositor's segment").to.not.eq(null);

    for (const depositor of orderedDepositors) {
      const encrypted = await pool.balanceOf(depositor.address);
      const postBalance = await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor);
      const preBalance = preBalances.get(depositor.address)!;

      if (depositor.address === expectedWinner) {
        expect(postBalance).to.eq(preBalance + prize);
      } else {
        expect(postBalance).to.eq(preBalance);
      }
    }
  });

  it("keeps solvency after the draw: pool custody and the sum of balances both rise by exactly the prize", async function () {
    const deposits: [HardhatEthersSigner, bigint][] = [
      [alice, 400_000_000n],
      [bob, 250_000_000n],
    ];
    for (const [depositor, amount] of deposits) {
      await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, depositor, amount);
    }

    const poolCustodyBefore = await fhevm.debugger.decryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(poolAddress),
    );
    const sumBefore = deposits.reduce((sum, [, amount]) => sum + amount, 0n);
    expect(poolCustodyBefore).to.eq(sumBefore);

    const { prize } = await runFullDraw();
    expect(prize).to.be.gt(0n);

    const poolCustodyAfter = await fhevm.debugger.decryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(poolAddress),
    );

    let sumAfter = 0n;
    for (const [depositor] of deposits) {
      const encrypted = await pool.balanceOf(depositor.address);
      sumAfter += await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor);
    }

    expect(poolCustodyAfter).to.eq(poolCustodyBefore + prize);
    expect(sumAfter).to.eq(sumBefore + prize);
    expect(poolCustodyAfter).to.eq(sumAfter);
  });

  it("keeps totalDeposits equal to the sum of depositor balances after the draw", async function () {
    const deposits: [HardhatEthersSigner, bigint][] = [
      [alice, 350_000_000n],
      [bob, 150_000_000n],
      [carol, 600_000_000n],
    ];
    for (const [depositor, amount] of deposits) {
      await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, depositor, amount);
    }

    await runFullDraw();

    let sumAfter = 0n;
    for (const [depositor] of deposits) {
      const encrypted = await pool.balanceOf(depositor.address);
      sumAfter += await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor);
    }

    const totalDepositsAfter = await fhevm.debugger.decryptEuint(FhevmType.euint64, await pool.totalDeposits());
    expect(totalDepositsAfter).to.eq(sumAfter);
  });

  it("runs a multi-batch draw across more than MAX_CHUNK depositors, crediting exactly the correct winner and preserving solvency", async function () {
    this.timeout(120_000);

    const extraCount = Number(MAX_CHUNK) + 5; // forces at least two advanceDraw batches
    const extraDepositors = await createFundedDepositors(deployer, extraCount);

    const baseAmount = 10_000_000n;
    const deposits: [HardhatEthersSigner, bigint][] = extraDepositors.map((d, i) => [d, baseAmount + BigInt(i) * 1_000_000n]);

    for (const [depositor, amount] of deposits) {
      await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, depositor, amount);
    }

    expect(await pool.depositorCount()).to.eq(BigInt(extraCount));

    const orderedDepositors: HardhatEthersSigner[] = [];
    const signerByAddress = new Map(extraDepositors.map((s) => [s.address, s]));
    for (let i = 0n; i < BigInt(extraCount); i++) {
      const address = await pool.depositorAt(i);
      orderedDepositors.push(signerByAddress.get(address)!);
    }

    const preBalances = new Map<string, bigint>();
    for (const depositor of orderedDepositors) {
      const encrypted = await pool.balanceOf(depositor.address);
      preBalances.set(
        depositor.address,
        await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor),
      );
    }

    const poolCustodyBefore = await fhevm.debugger.decryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(poolAddress),
    );

    const { clearTotal, prize, dart, zeroTotal } = await startAndReveal();
    expect(zeroTotal).to.eq(false);

    const [cursorAfterReveal] = await pool.drawProgress();
    expect(cursorAfterReveal).to.eq(0n);

    const callsMade = await advanceUntilIdle(MAX_CHUNK);
    expect(callsMade, "expected more than one advanceDraw call to cover every depositor").to.be.gt(1);

    const [finalCursor, finalTotal] = await pool.drawProgress();
    expect(finalCursor).to.eq(finalTotal);
    expect(finalTotal).to.eq(BigInt(extraCount));

    const totalDeposited = deposits.reduce((sum, [, amount]) => sum + amount, 0n);
    expect(clearTotal).to.eq(totalDeposited);

    const expectedWinner = await expectedWinnerFromDart(orderedDepositors, preBalances, dart);
    expect(expectedWinner, "the dart must fall inside exactly one depositor's segment").to.not.eq(null);

    let sumAfter = 0n;
    for (const depositor of orderedDepositors) {
      const encrypted = await pool.balanceOf(depositor.address);
      const postBalance = await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor);
      const preBalance = preBalances.get(depositor.address)!;
      sumAfter += postBalance;

      if (depositor.address === expectedWinner) {
        expect(postBalance).to.eq(preBalance + prize);
      } else {
        expect(postBalance).to.eq(preBalance);
      }
    }

    const poolCustodyAfter = await fhevm.debugger.decryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(poolAddress),
    );
    expect(poolCustodyAfter).to.eq(poolCustodyBefore + prize);
    expect(sumAfter).to.eq(poolCustodyAfter);
  });

  it("completes a full MAX_CHUNK-sized batch in a single advanceDraw call, selecting correctly", async function () {
    this.timeout(120_000);

    const depositorCount = Number(MAX_CHUNK);
    const exactDepositors = await createFundedDepositors(deployer, depositorCount);

    const baseAmount = 20_000_000n;
    const deposits: [HardhatEthersSigner, bigint][] = exactDepositors.map((d, i) => [
      d,
      baseAmount + BigInt(i) * 2_000_000n,
    ]);
    for (const [depositor, amount] of deposits) {
      await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, depositor, amount);
    }
    expect(await pool.depositorCount()).to.eq(MAX_CHUNK);

    const orderedDepositors: HardhatEthersSigner[] = [];
    const signerByAddress = new Map(exactDepositors.map((s) => [s.address, s]));
    for (let i = 0n; i < MAX_CHUNK; i++) {
      const address = await pool.depositorAt(i);
      orderedDepositors.push(signerByAddress.get(address)!);
    }

    const preBalances = new Map<string, bigint>();
    for (const depositor of orderedDepositors) {
      const encrypted = await pool.balanceOf(depositor.address);
      preBalances.set(
        depositor.address,
        await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor),
      );
    }

    const { prize, dart, zeroTotal } = await startAndReveal();
    expect(zeroTotal).to.eq(false);

    expect(await pool.drawState()).to.eq(DrawStateWalking);
    await (await pool.advanceDraw(MAX_CHUNK)).wait();
    expect(await pool.drawState()).to.eq(DrawStateIdle);

    const expectedWinner = await expectedWinnerFromDart(orderedDepositors, preBalances, dart);
    expect(expectedWinner).to.not.eq(null);

    for (const depositor of orderedDepositors) {
      const encrypted = await pool.balanceOf(depositor.address);
      const postBalance = await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor);
      const preBalance = preBalances.get(depositor.address)!;

      if (depositor.address === expectedWinner) {
        expect(postBalance).to.eq(preBalance + prize);
      } else {
        expect(postBalance).to.eq(preBalance);
      }
    }
  });

  it("freezes deposits and withdrawals with DrawActive while Revealing", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);

    await time.increase(DRAW_INTERVAL);
    await (await pool.startDraw()).wait();
    expect(await pool.drawState()).to.eq(DrawStateRevealing);

    await (await token.connect(bob).claim()).wait();
    await (await token.connect(bob).approve(wrapperAddress, 50_000_000n)).wait();
    await (await wrapper.connect(bob).wrap(bob.address, 50_000_000n)).wait();
    const encryptedDeposit = await fhevm.createEncryptedInput(wrapperAddress, bob.address).add64(50_000_000n).encrypt();
    await expect(
      wrapper
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
          poolAddress,
          encryptedDeposit.handles[0],
          encryptedDeposit.inputProof,
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "DrawActive");

    const encryptedWithdraw = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(1n).encrypt();
    await expect(
      pool.connect(alice).withdraw(encryptedWithdraw.handles[0], encryptedWithdraw.inputProof),
    ).to.be.revertedWithCustomError(pool, "DrawActive");
  });

  it("freezes deposits and withdrawals with DrawActive while Walking", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);

    const { zeroTotal } = await startAndReveal();
    expect(zeroTotal).to.eq(false);
    expect(await pool.drawState()).to.eq(DrawStateWalking);

    await (await token.connect(bob).claim()).wait();
    await (await token.connect(bob).approve(wrapperAddress, 50_000_000n)).wait();
    await (await wrapper.connect(bob).wrap(bob.address, 50_000_000n)).wait();
    const encryptedDeposit = await fhevm.createEncryptedInput(wrapperAddress, bob.address).add64(50_000_000n).encrypt();
    await expect(
      wrapper
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
          poolAddress,
          encryptedDeposit.handles[0],
          encryptedDeposit.inputProof,
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "DrawActive");

    const encryptedWithdraw = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(1n).encrypt();
    await expect(
      pool.connect(alice).withdraw(encryptedWithdraw.handles[0], encryptedWithdraw.inputProof),
    ).to.be.revertedWithCustomError(pool, "DrawActive");

    // Clean up so the fixture teardown does not leave a dangling Walking draw.
    await advanceUntilIdle();
  });

  it("lets a non-privileged account abort a stalled reveal after the timeout, lifting the freeze", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);

    await time.increase(DRAW_INTERVAL);
    await (await pool.startDraw()).wait();
    expect(await pool.drawState()).to.eq(DrawStateRevealing);

    await time.increase(DRAW_TIMEOUT + 1n);

    const lastDrawBefore = await pool.lastDraw();
    await (await pool.connect(carol).abortDraw()).wait();
    expect(await pool.drawState()).to.eq(DrawStateIdle);
    expect(await pool.lastDraw()).to.eq(lastDrawBefore); // unchanged, so a retry need not wait a full interval

    // Deposits and withdrawals work again.
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, bob, 25_000_000n);
    const encryptedWithdraw = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(10_000_000n).encrypt();
    await expect(pool.connect(alice).withdraw(encryptedWithdraw.handles[0], encryptedWithdraw.inputProof)).to.not.be
      .reverted;

    // lastDraw untouched by the abort, so a fresh draw can start immediately.
    await expect(pool.startDraw()).to.not.be.reverted;
  });

  it("reverts abortDraw before the timeout has elapsed", async function () {
    await time.increase(DRAW_INTERVAL);
    await (await pool.startDraw()).wait();

    await expect(pool.abortDraw()).to.be.revertedWithCustomError(pool, "AbortNotReady");
  });

  it("reverts abortDraw while Walking, even after the timeout", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);

    const { zeroTotal } = await startAndReveal();
    expect(zeroTotal).to.eq(false);
    expect(await pool.drawState()).to.eq(DrawStateWalking);

    await time.increase(DRAW_TIMEOUT + 1n);

    await expect(pool.abortDraw()).to.be.revertedWithCustomError(pool, "AbortNotReady");

    // Clean up so the fixture teardown does not leave a dangling Walking draw.
    await advanceUntilIdle();
  });

  it("reverts startDraw when called again before the next interval has elapsed", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);

    await time.increase(DRAW_INTERVAL);
    await (await pool.startDraw()).wait();

    // Still Revealing: an immediate second call must revert.
    await expect(pool.startDraw()).to.be.revertedWithCustomError(pool, "DrawNotReady");
  });

  it("reverts startDraw immediately after a completed draw, before the interval elapses again", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);
    await runFullDraw();

    await expect(pool.startDraw()).to.be.revertedWithCustomError(pool, "DrawNotReady");
  });

  it("reverts fulfillReveal when the submitted clearTotal does not match the real reveal", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);
    await time.increase(DRAW_INTERVAL);

    const startTx = await pool.startDraw();
    const startReceipt = await startTx.wait();
    const drawStarted = startReceipt!.logs
      .map((log) => pool.interface.parseLog(log))
      .find((parsed) => parsed?.name === "DrawStarted");
    const totalHandle: string = drawStarted!.args.total;

    const decryption = await fhevm.publicDecrypt([totalHandle]);
    const clearTotal = Object.values(decryption.clearValues)[0] as bigint;

    await expect(pool.fulfillReveal(clearTotal + 1n, decryption.decryptionProof)).to.be.reverted;
  });

  it("reverts fulfillReveal when the proof is invalid", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);
    await time.increase(DRAW_INTERVAL);

    const startTx = await pool.startDraw();
    const startReceipt = await startTx.wait();
    const drawStarted = startReceipt!.logs
      .map((log) => pool.interface.parseLog(log))
      .find((parsed) => parsed?.name === "DrawStarted");
    const totalHandle: string = drawStarted!.args.total;

    const decryption = await fhevm.publicDecrypt([totalHandle]);
    const clearTotal = Object.values(decryption.clearValues)[0] as bigint;

    await expect(pool.fulfillReveal(clearTotal, "0x00")).to.be.reverted;
  });

  it("completes a zero-total draw without harvesting, walking, or crediting anyone", async function () {
    // No deposits at all.
    const { clearTotal, zeroTotal } = await startAndReveal();
    expect(clearTotal).to.eq(0n);
    expect(zeroTotal).to.eq(true);

    expect(await pool.drawState()).to.eq(DrawStateIdle);
    expect(await pool.depositorCount()).to.eq(0n);
  });

  it("reverts a reveal-signature replay: an old draw's valid (clearTotal, proof) cannot verify against a new draw's handle", async function () {
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, alice, 100_000_000n);

    // Complete one full draw and capture its valid (clearTotal, proof) pair.
    await time.increase(DRAW_INTERVAL);
    const firstStartTx = await pool.startDraw();
    const firstStartReceipt = await firstStartTx.wait();
    const firstDrawStarted = firstStartReceipt!.logs
      .map((log) => pool.interface.parseLog(log))
      .find((parsed) => parsed?.name === "DrawStarted");
    const firstTotalHandle: string = firstDrawStarted!.args.total;

    const firstDecryption = await fhevm.publicDecrypt([firstTotalHandle]);
    const oldClearTotal = Object.values(firstDecryption.clearValues)[0] as bigint;
    const oldProof = firstDecryption.decryptionProof;

    await (await pool.fulfillReveal(oldClearTotal, oldProof)).wait();
    await advanceUntilIdle();
    expect(await pool.drawState()).to.eq(DrawStateIdle);

    // Change the pool total so the next draw's real total would differ too, then
    // start a second, independent draw: a fresh ciphertext handle even if the
    // underlying numeric total happened to coincide.
    await claimWrapAndDeposit(token, wrapper, wrapperAddress, poolAddress, bob, 50_000_000n);

    await time.increase(DRAW_INTERVAL);
    await (await pool.startDraw()).wait();
    expect(await pool.drawState()).to.eq(DrawStateRevealing);

    // The old, genuinely-valid (clearTotal, proof) pair must not verify against the
    // new draw's snapshotted handle.
    await expect(pool.fulfillReveal(oldClearTotal, oldProof)).to.be.reverted;

    // The new draw is unaffected: it can still be completed normally with its own
    // real reveal.
    expect(await pool.drawState()).to.eq(DrawStateRevealing);
  });
});
