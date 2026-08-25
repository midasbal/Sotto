import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, fhevm } from "hardhat";
import {
  ConfidentialTestUSD,
  ConfidentialTestUSD__factory,
  ReserveYieldSource,
  ReserveYieldSource__factory,
  TestUSD,
  TestUSD__factory,
} from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

const RATE_SCALE = 10n ** 18n;

describe("ReserveYieldSource", function () {
  let owner: HardhatEthersSigner;
  let consumer: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let token: TestUSD;
  let tokenAddress: string;
  let wrapper: ConfidentialTestUSD;
  let wrapperAddress: string;
  let yieldSource: ReserveYieldSource;
  let yieldSourceAddress: string;

  const principalBasis = 1_000_000_000n; // an arbitrary aggregate pool total, 6 decimals
  const rate = RATE_SCALE / 1_000_000_000n; // yields exactly 1 raw unit of prize per second at this basis

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    consumer = signers[1];
    recipient = signers[2];
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
      owner.address,
    )) as ReserveYieldSource;
    yieldSourceAddress = await yieldSource.getAddress();

    await (await token.connect(owner).claim()).wait();
    await (await token.connect(owner).approve(yieldSourceAddress, await token.FAUCET_AMOUNT())).wait();
    await (await yieldSource.connect(owner).fund(await token.FAUCET_AMOUNT())).wait();

    await (await yieldSource.connect(owner).setRate(rate)).wait();
    await (await yieldSource.connect(owner).setConsumer(consumer.address)).wait();
  });

  it("accrues pendingPrize with elapsed time per the formula", async function () {
    const lastAccrualBefore = await yieldSource.lastAccrual();

    await time.increase(100);

    const pending = await yieldSource.pendingPrize(principalBasis);

    const latestBlock = await ethers.provider.getBlock("latest");
    const actualElapsed = BigInt(latestBlock!.timestamp) - lastAccrualBefore;
    const expectedPrize = (principalBasis * rate * actualElapsed) / RATE_SCALE;

    expect(pending).to.eq(expectedPrize);
    expect(pending).to.be.gt(0n);
  });

  it("caps pendingPrize at the reserve once accrued would exceed it", async function () {
    const reserveBalance = await token.balanceOf(yieldSourceAddress);

    // A rate high enough that a short elapsed window already accrues far past the reserve.
    const hugeRate = RATE_SCALE * 1_000_000n;
    await (await yieldSource.connect(owner).setRate(hugeRate)).wait();
    await time.increase(10);

    const pending = await yieldSource.pendingPrize(principalBasis);
    expect(pending).to.eq(reserveBalance);
  });

  it("delivers exactly the formula prize as ctUSD on harvest, drains the reserve by that amount, and resets the clock", async function () {
    const lastAccrualBefore = await yieldSource.lastAccrual();
    const reserveBefore = await token.balanceOf(yieldSourceAddress);

    await time.increase(200);

    const harvestTx = await yieldSource.connect(consumer).harvest(recipient.address, principalBasis);
    const harvestReceipt = await harvestTx.wait();
    const harvestBlock = await ethers.provider.getBlock(harvestReceipt!.blockNumber);
    const actualElapsed = BigInt(harvestBlock!.timestamp) - lastAccrualBefore;
    const expectedPrize = (principalBasis * rate * actualElapsed) / RATE_SCALE;

    expect(expectedPrize).to.be.gt(0n);
    expect(expectedPrize).to.be.lt(reserveBefore);

    const encryptedRecipientBalance = await wrapper.confidentialBalanceOf(recipient.address);
    const clearRecipientBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedRecipientBalance,
      wrapperAddress,
      recipient,
    );
    expect(clearRecipientBalance).to.eq(expectedPrize);

    const reserveAfter = await token.balanceOf(yieldSourceAddress);
    expect(reserveBefore - reserveAfter).to.eq(expectedPrize);

    expect(await yieldSource.lastAccrual()).to.eq(BigInt(harvestBlock!.timestamp));

    const pendingRightAfter = await yieldSource.pendingPrize(principalBasis);
    expect(pendingRightAfter).to.eq(0n);
  });

  it("caps harvest at the reserve and never wraps more than the reserve holds", async function () {
    const reserveBalance = await token.balanceOf(yieldSourceAddress);

    const hugeRate = RATE_SCALE * 1_000_000n;
    await (await yieldSource.connect(owner).setRate(hugeRate)).wait();
    await time.increase(10);

    await (await yieldSource.connect(consumer).harvest(recipient.address, principalBasis)).wait();

    const encryptedRecipientBalance = await wrapper.confidentialBalanceOf(recipient.address);
    const clearRecipientBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedRecipientBalance,
      wrapperAddress,
      recipient,
    );
    expect(clearRecipientBalance).to.eq(reserveBalance);

    const reserveAfter = await token.balanceOf(yieldSourceAddress);
    expect(reserveAfter).to.eq(0n);
  });

  it("reverts when harvest is called by a non-consumer", async function () {
    await time.increase(100);

    await expect(yieldSource.connect(recipient).harvest(recipient.address, principalBasis))
      .to.be.revertedWithCustomError(yieldSource, "UnauthorizedConsumer")
      .withArgs(recipient.address);
  });
});
