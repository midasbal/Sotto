import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { TestUSD, TestUSD__factory } from "../types";
import { expect } from "chai";

describe("TestUSD", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let token: TestUSD;

  before(async function () {
    const signers = await ethers.getSigners();
    alice = signers[1];
    bob = signers[2];
  });

  beforeEach(async function () {
    const tokenFactory = (await ethers.getContractFactory("TestUSD")) as TestUSD__factory;
    token = (await tokenFactory.deploy()) as TestUSD;
  });

  it("mints exactly FAUCET_AMOUNT to the caller on claim", async function () {
    const faucetAmount = await token.FAUCET_AMOUNT();

    await (await token.connect(alice).claim()).wait();

    expect(await token.balanceOf(alice.address)).to.eq(faucetAmount);
  });

  it("reverts an immediate second claim with the cooldown error", async function () {
    await (await token.connect(alice).claim()).wait();

    await expect(token.connect(alice).claim()).to.be.revertedWithCustomError(token, "FaucetCooldownActive");
  });

  it("allows a claim again once FAUCET_COOLDOWN has elapsed", async function () {
    const faucetAmount = await token.FAUCET_AMOUNT();
    const cooldown = await token.FAUCET_COOLDOWN();

    await (await token.connect(alice).claim()).wait();
    await time.increase(cooldown);
    await (await token.connect(alice).claim()).wait();

    expect(await token.balanceOf(alice.address)).to.eq(faucetAmount * 2n);
  });

  it("tracks the cooldown independently per address", async function () {
    const faucetAmount = await token.FAUCET_AMOUNT();

    await (await token.connect(alice).claim()).wait();
    await (await token.connect(bob).claim()).wait();

    expect(await token.balanceOf(alice.address)).to.eq(faucetAmount);
    expect(await token.balanceOf(bob.address)).to.eq(faucetAmount);
  });
});
