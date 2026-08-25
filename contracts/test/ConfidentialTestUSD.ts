import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { ConfidentialTestUSD, ConfidentialTestUSD__factory, TestUSD, TestUSD__factory } from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

describe("ConfidentialTestUSD", function () {
  let alice: HardhatEthersSigner;
  let token: TestUSD;
  let tokenAddress: string;
  let wrapper: ConfidentialTestUSD;
  let wrapperAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    alice = signers[1];
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
  });

  it("reports 6 decimals on both the underlying and the wrapper, with rate() == 1", async function () {
    expect(await token.decimals()).to.eq(6);
    expect(await wrapper.decimals()).to.eq(6);
    expect(await wrapper.rate()).to.eq(1n);
  });

  it("wraps public tUSD into confidential ctUSD one to one", async function () {
    const wrapAmount = 250_000_000n; // 250 tUSD at 6 decimals

    await (await token.connect(alice).claim()).wait();
    await (await token.connect(alice).approve(wrapperAddress, wrapAmount)).wait();
    await (await wrapper.connect(alice).wrap(alice.address, wrapAmount)).wait();

    const encryptedBalance = await wrapper.confidentialBalanceOf(alice.address);
    const clearBalance = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedBalance, wrapperAddress, alice);

    expect(clearBalance).to.eq(wrapAmount);
    expect(await token.balanceOf(alice.address)).to.eq((await token.FAUCET_AMOUNT()) - wrapAmount);
  });

  it("creates a correctly-shaped unwrap request and finalizes it via a real mock KMS decryption", async function () {
    const wrapAmount = 300_000_000n; // 300 tUSD
    const unwrapAmount = 120_000_000n; // 120 tUSD

    await (await token.connect(alice).claim()).wait();
    await (await token.connect(alice).approve(wrapperAddress, wrapAmount)).wait();
    await (await wrapper.connect(alice).wrap(alice.address, wrapAmount)).wait();

    const encryptedUnwrapAmount = await fhevm
      .createEncryptedInput(wrapperAddress, alice.address)
      .add64(unwrapAmount)
      .encrypt();

    const unwrapTx = await wrapper
      .connect(alice)
      ["unwrap(address,address,bytes32,bytes)"](
        alice.address,
        alice.address,
        encryptedUnwrapAmount.handles[0],
        encryptedUnwrapAmount.inputProof,
      );
    const unwrapReceipt = await unwrapTx.wait();

    const unwrapRequestedEvent = unwrapReceipt!.logs
      .map((log) => wrapper.interface.parseLog(log))
      .find((parsed) => parsed?.name === "UnwrapRequested");
    expect(unwrapRequestedEvent, "expected an UnwrapRequested event").to.not.eq(undefined);

    const unwrapRequestId: string = unwrapRequestedEvent!.args.unwrapRequestId;
    expect(unwrapRequestId).to.not.eq(ethers.ZeroHash);
    expect(await wrapper.unwrapRequester(unwrapRequestId)).to.eq(alice.address);

    // The confidential balance is burned immediately on request, before finalization.
    const balanceAfterRequest = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await wrapper.confidentialBalanceOf(alice.address),
      wrapperAddress,
      alice,
    );
    expect(balanceAfterRequest).to.eq(wrapAmount - unwrapAmount);

    // Finalize via a genuine mock KMS public decryption of the unwrap request handle,
    // exercising the real oracle-signature verification path rather than a stub.
    const decryption = await fhevm.publicDecrypt([unwrapRequestId]);
    const cleartextAmount = Object.values(decryption.clearValues)[0] as bigint;
    expect(cleartextAmount).to.eq(unwrapAmount);

    const tUsdBalanceBeforeFinalize = await token.balanceOf(alice.address);

    await (
      await wrapper
        .connect(alice)
        .finalizeUnwrap(unwrapRequestId, cleartextAmount, decryption.decryptionProof)
    ).wait();

    expect(await token.balanceOf(alice.address)).to.eq(tUsdBalanceBeforeFinalize + unwrapAmount);
    expect(await wrapper.unwrapRequester(unwrapRequestId)).to.eq(ethers.ZeroAddress);
  });
});
