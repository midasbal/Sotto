# it’s a wip, i’m not gonna finish it. feel free to take the idea and run with it.

# Sotto

No-loss prize savings, private end to end. A confidential PoolTogether built on the Zama Protocol (FHEVM).

## Status

This is contract-only work. "Implemented" below means the contract exists and passes the local FHEVM mock test suite, not that it is deployed or verified on any live network. There is still no live URL, no frontend, and no deployment.

**Implemented (contract-complete, mock-tested):**

- `TestUSD`: a 6-decimal test ERC-20 with a rate-limited faucet.
- `ConfidentialTestUSD`: an OpenZeppelin ERC-7984 confidential wrapper over `TestUSD`.
- `Pool`: encrypted deposits, encrypted per-depositor balances, no-loss confidential withdrawals, and the confidential prize draw. The draw does deposit-weighted winner selection over encrypted balances using on-chain FHE randomness, revealing only the aggregate pool total at draw time through a KMS-signature-verified decryption. The prize is compounded silently into the winner's encrypted balance, so only the winner learns they won. The selection walk is chunked across multiple transactions, deposits and withdrawals are paused automatically for the brief duration of a draw, and a timeout lets anyone abort a stalled reveal so funds can never be trapped.
- `IYieldSource` / `ReserveYieldSource`: a pluggable interface for the prize-funding source, with a reserve implementation whose prize accrues by a real formula over time. On a testnet the reserve is operator-funded rather than earned from real economic yield; the interface exists so a real external yield source could be substituted later without changing the pool.

**Not implemented yet:**

- A frontend.
- Any Sepolia or live deployment.
- Verification that the draw's batch size fits the real on-chain compute (HCU) budget. This has only been checked against the FHEVM mock, which does not enforce that budget; confirming it on real hardware is pending a Sepolia deployment.

## How it works

A no-loss prize-savings pool lets depositors keep their full principal available to withdraw at any time; principal is never at risk. A depositor deposits confidentially, and their balance is credited entirely in encrypted form. A reserve accrues a prize over time. On a fixed interval, anyone can trigger a draw: it reveals only the aggregate pool total, then selects a deposit-weighted winner over encrypted balances using on-chain FHE randomness. The prize lands silently in the winner's encrypted balance; no one else learns who won. Principal stays withdrawable at any time, except for the brief automatic window while a draw is in progress.

## Confidentiality model

| Confidential today | Public today |
| --- | --- |
| Deposit amounts | Depositor addresses (the depositor set is a public, append-only array, so participation is visible) |
| Pool balances | The fact that a deposit, withdrawal, or draw occurred |
| Withdrawal amounts | Wrap and unwrap amounts at the public token boundary |
| The winner's identity (only the winner learns they won) | The aggregate pool total (revealed at each draw) |
| Each depositor's odds | The prize amount (public by design, like any advertised jackpot) |

The confidentiality design is now complete in the contracts. What remains before this can be relied on is deployment and its own scrutiny, not further privacy work.

## Components

- **TestUSD** (`contracts/contracts/TestUSD.sol`): a standard 6-decimal ERC-20 for testing, with a `claim()` faucet that mints a fixed amount per address on a cooldown.
- **ConfidentialTestUSD** (`contracts/contracts/ConfidentialTestUSD.sol`): an ERC-7984 confidential token wrapping `TestUSD`. Wrapping and unwrapping are the public boundary between plaintext and confidential balances; amounts are public at that boundary by design.
- **Pool** (`contracts/contracts/Pool.sol`): accepts `ConfidentialTestUSD` deposits via a confidential transfer-and-call, credits an encrypted per-depositor balance, and allows no-loss withdrawal of principal. It also runs the prize draw: a permissionless start-reveal-walk lifecycle that reveals only the aggregate total, selects a deposit-weighted winner with on-chain FHE randomness, and credits the prize silently. Deposits and withdrawals pause automatically for the duration of a draw; a timeout lets anyone abort a stalled reveal.
- **IYieldSource** (`contracts/contracts/IYieldSource.sol`): the interface a prize-funding source implements, to report a pending prize and to harvest it.
- **ReserveYieldSource** (`contracts/contracts/ReserveYieldSource.sol`): the current `IYieldSource` implementation, an operator-funded reserve that accrues a prize by a real time-based formula. Real economic yield generation is not part of this milestone; a different `IYieldSource` implementation could supply it without changing the pool.

## Build and test

From the `contracts/` directory:

```bash
npm install
npm test
```

Tests run against the local FHEVM mock network provided by the Hardhat plugin. The current suite has 35 passing tests.

## Trust and limitations

- No-loss holds: principal is never at risk.
- Deposits and withdrawals pause only for the automatic, self-contained duration of a draw. That pause is enforced by the contract's own draw state machine, not by an operator.
- The draw is trust-minimized: no party controls whether or when draws happen beyond the fixed interval, or who wins.
- Known limitation: because deposit amounts are encrypted, the contract cannot reject zero-value deposits, so the depositor set can be inflated with dust entries, which raises the cost and duration of each draw. This is a liveness and cost consideration, not a fund-safety one. A fuller threat model will accompany deployment.

## Roadmap

- **Frontend**: a dApp for depositing, withdrawing, and viewing draws.
- **Deployment**: a live deployment, starting with Sepolia, including verifying the draw's batch size against the real on-chain compute (HCU) budget.

## Built with

- The Zama Protocol (FHEVM)
- OpenZeppelin Confidential Contracts

Scaffolded from Zama's `fhevm-hardhat-template` (BSD-3-Clause-Clear; see [NOTICE](./NOTICE)). Built for the Zama Developer Program.

## License

MIT. See [LICENSE](./LICENSE). Third-party license notices are in [NOTICE](./NOTICE).
