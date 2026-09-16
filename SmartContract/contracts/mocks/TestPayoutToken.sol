// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Shared test-only ERC20, analogous to MockClaimRegistrySink — used
///      by both Foundry unit tests and integration-fixture deploy
///      scripts so they don't each redeclare their own token contract.
contract TestPayoutToken is ERC20 {
    constructor() ERC20("Test Payout Token", "TPT") {
        _mint(msg.sender, 10_000_000 ether);
    }
}
