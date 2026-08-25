# Sotto

No-loss prize savings, private end to end. A confidential PoolTogether built on the Zama Protocol (FHEVM).

## Status

This is early-stage, contracts-only work. There is no live deployment yet.

**Implemented:**

- `TestUSD`: a 6-decimal test ERC-20 with a rate-limited faucet.
- `ConfidentialTestUSD`: an OpenZeppelin ERC-7984 confidential wrapper over `TestUSD`.
- `Pool`: the confidential pool core, with encrypted deposits, encrypted per-depositor balances, and no-loss confidential withdrawals.

**Not implemented yet:**

- The prize draw.
- The yield source that funds prizes.
- A frontend.
- Any Sepolia or live deployment.

## How it works

A no-loss prize-savings pool lets depositors keep their full principal available to withdraw at any time. Instead of paying interest to everyone, pooled yield is meant to fund periodic prizes, with odds proportional to how much each depositor has saved. Today, only the savings side of this exists: depositing, holding an encrypted balance, and withdrawing. The prize side (yield generation and the draw that awards it) is not built yet.

## Confidentiality model

| Confidential today | Public today | Planned |
| --- | --- | --- |
| Deposit amounts | Depositor addresses (the depositor set is a public array) | Winner-only decryption of prizes |
| Pool balances | The fact that a deposit or withdrawal occurred | The deposit-weighted confidential draw |
| Withdrawal amounts | Wrap/unwrap amounts at the public token boundary | |

Participation itself is not hidden: who has deposited, and when, is visible on chain. What is hidden is how much.

## Components

- **TestUSD** (`contracts/contracts/TestUSD.sol`): a standard 6-decimal ERC-20 for testing, with a `claim()` faucet that mints a fixed amount per address on a cooldown.
- **ConfidentialTestUSD** (`contracts/contracts/ConfidentialTestUSD.sol`): an ERC-7984 confidential token wrapping `TestUSD`. Wrapping and unwrapping are the public boundary between plaintext and confidential balances; amounts are public at that boundary by design.
- **Pool** (`contracts/contracts/Pool.sol`): accepts `ConfidentialTestUSD` deposits via a confidential transfer-and-call, credits an encrypted per-depositor balance, and allows no-loss withdrawal of principal. Each depositor's balance is only decryptable by that depositor.

## Build and test

From the `contracts/` directory:

```bash
npm install
npm test
```

Tests run against the local FHEVM mock network provided by the Hardhat plugin.

## Roadmap

- **Prize draw**: deposit-weighted winner selection over encrypted balances, using FHE randomness, revealing only the aggregate pool total at draw time.
- **Yield source**: the mechanism that generates the funds paid out as prizes.
- **Frontend**: a dApp for depositing, withdrawing, and viewing draws.
- **Deployment**: a live deployment, starting with Sepolia.

## Built with

- The Zama Protocol (FHEVM)
- OpenZeppelin Confidential Contracts

Scaffolded from Zama's `fhevm-hardhat-template` (BSD-3-Clause-Clear; see [NOTICE](./NOTICE)). Built for the Zama Developer Program.

## License

MIT. See [LICENSE](./LICENSE). Third-party license notices are in [NOTICE](./NOTICE).
