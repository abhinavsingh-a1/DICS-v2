// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock collateral asset for Vault.sol — stands in for a real
///      exogenous collateral (e.g. wrapped ETH). Same "test-only,
///      clearly labeled" pattern as TestPayoutToken.sol.
contract TestCollateralToken is ERC20 {
    constructor() ERC20("Test Wrapped ETH (demo)", "tWETH") {
        _mint(msg.sender, 1_000_000 ether);
    }
}
