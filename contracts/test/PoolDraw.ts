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

describe("Pool draw (phase 4a)", function () {
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
    pool = (await poolFactory.deploy(wrapperAddress, yieldSourceAddress, DRAW_INTERVAL)) as Pool;
    poolAddress = await pool.getAddress();

    await (await yieldSource.connect(deployer).setConsumer(poolAddress)).wait();

    await (await token.connect(deployer).claim()).wait();
    await (
      await token.connect(deployer).approve(yieldSourceAddress, await token.FAUCET_AMOUNT())
    ).wait();
    await (await yieldSource.connect(deployer).fund(await token.FAUCET_AMOUNT())).wait();
    // A generous rate: with three deposits on the order of 1e8-1e9 and a short elapsed
    // window, this accrues a prize comfortably inside the reserve without capping it,
    // so the draw exercises the real accrual formula rather than the reserve cap.
    await (await yieldSource.connect(deployer).setRate(RATE_SCALE / 10_000n)).wait();
  });

  async function runFullDraw(): Promise<{ clearTotal: bigint; prize: bigint; dart: bigint }> {
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

    const fulfillTx = await pool.fulfillDraw(clearTotal, decryption.decryptionProof);
    const fulfillReceipt = await fulfillTx.wait();
    const parsedLogs = fulfillReceipt!.logs.map((log) => pool.interface.parseLog(log));

    const dartDrawn = parsedLogs.find((parsed) => parsed?.name === "DrawDartDrawn");
    const drawCompleted = parsedLogs.find((parsed) => parsed?.name === "DrawCompleted");
    expect(drawCompleted, "expected a DrawCompleted event").to.not.eq(undefined);

    let dart = 0n;
    if (dartDrawn) {
      dart = await fhevm.debugger.decryptEuint(FhevmType.euint64, dartDrawn.args.dart);
    }

    return { clearTotal, prize: drawCompleted!.args.prize as bigint, dart };
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
      preBalances.set(depositor.address, await fhevm.userDecryptEuint(FhevmType.euint64, encrypted, poolAddress, depositor));
    }

    const { clearTotal, prize, dart } = await runFullDraw();

    const totalDeposited = deposits.reduce((sum, [, amount]) => sum + amount, 0n);
    expect(clearTotal).to.eq(totalDeposited);
    expect(dart).to.be.gte(0n);
    expect(dart).to.be.lt(clearTotal);

    // Recompute, off chain, exactly the same segment walk fulfillDraw performs.
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

  it("reverts fulfillDraw when the submitted clearTotal does not match the real reveal", async function () {
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

    await expect(pool.fulfillDraw(clearTotal + 1n, decryption.decryptionProof)).to.be.reverted;
  });

  it("reverts fulfillDraw when the proof is invalid", async function () {
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

    await expect(pool.fulfillDraw(clearTotal, "0x00")).to.be.reverted;
  });

  it("completes a zero-total draw without harvesting or crediting anyone", async function () {
    // No deposits at all.
    await time.increase(DRAW_INTERVAL);

    const startTx = await pool.startDraw();
    const startReceipt = await startTx.wait();
    const drawStarted = startReceipt!.logs
      .map((log) => pool.interface.parseLog(log))
      .find((parsed) => parsed?.name === "DrawStarted");
    const totalHandle: string = drawStarted!.args.total;

    const decryption = await fhevm.publicDecrypt([totalHandle]);
    const clearTotal = Object.values(decryption.clearValues)[0] as bigint;
    expect(clearTotal).to.eq(0n);

    const fulfillTx = await pool.fulfillDraw(clearTotal, decryption.decryptionProof);
    const fulfillReceipt = await fulfillTx.wait();
    const drawCompleted = fulfillReceipt!.logs
      .map((log) => pool.interface.parseLog(log))
      .find((parsed) => parsed?.name === "DrawCompleted");
    expect(drawCompleted, "expected a DrawCompleted event").to.not.eq(undefined);
    expect(drawCompleted!.args.clearTotal).to.eq(0n);
    expect(drawCompleted!.args.prize).to.eq(0n);

    expect(await pool.drawState()).to.eq(0n); // Idle
    expect(await pool.depositorCount()).to.eq(0n);
  });
});
