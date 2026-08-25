import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { Smoke, Smoke__factory } from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

describe("Smoke", function () {
  let alice: HardhatEthersSigner;
  let smoke: Smoke;
  let smokeAddress: string;

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

    const smokeFactory = (await ethers.getContractFactory("Smoke")) as Smoke__factory;
    smoke = (await smokeFactory.deploy()) as Smoke;
    smokeAddress = await smoke.getAddress();
  });

  it("stores an encrypted value and the same signer can user-decrypt it", async function () {
    const value = 42;

    const encryptedValue = await fhevm.createEncryptedInput(smokeAddress, alice.address).add64(value).encrypt();

    await (await smoke.connect(alice).store(encryptedValue.handles[0], encryptedValue.inputProof)).wait();

    const storedHandle = await smoke.get();
    const clearValue = await fhevm.userDecryptEuint(FhevmType.euint64, storedHandle, smokeAddress, alice);

    expect(clearValue).to.eq(BigInt(value));
  });
});
