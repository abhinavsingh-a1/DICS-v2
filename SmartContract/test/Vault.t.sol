// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Vault} from "../contracts/Vault.sol";
import {StableCoin} from "../contracts/StableCoin.sol";
import {PriceOracle} from "../contracts/PriceOracle.sol";
import {TestCollateralToken} from "../contracts/mocks/TestCollateralToken.sol";

contract VaultTest is Test {
    Vault public vault;
    StableCoin public stableCoin;
    PriceOracle public priceOracle;
    TestCollateralToken public collateral;

    address public timelock = makeAddr("timelock");
    address public alice = makeAddr("alice");
    address public liquidatorEoa = makeAddr("liquidatorEoa");

    uint256 public constant MIN_RATIO_BPS = 15_000; // 150%
    uint256 public constant LIQ_PENALTY_BPS = 1_000; // 10%
    uint256 public constant INITIAL_PRICE = 2_000 ether; // $2,000 per collateral unit

    function setUp() public {
        collateral = new TestCollateralToken();

        PriceOracle priceOracleImpl = new PriceOracle();
        bytes memory priceInit =
            abi.encodeWithSelector(PriceOracle.initialize.selector, timelock, INITIAL_PRICE);
        priceOracle = PriceOracle(address(new ERC1967Proxy(address(priceOracleImpl), priceInit)));
        bytes32 priceSetterRole = priceOracle.PRICE_SETTER_ROLE();
        vm.prank(timelock);
        priceOracle.grantRole(priceSetterRole, timelock);

        Vault vaultImpl = new Vault();
        bytes memory vaultInit = abi.encodeWithSelector(
            Vault.initialize.selector,
            timelock,
            address(collateral),
            address(priceOracle),
            MIN_RATIO_BPS,
            LIQ_PENALTY_BPS
        );
        vault = Vault(address(new ERC1967Proxy(address(vaultImpl), vaultInit)));

        stableCoin = new StableCoin();
        stableCoin.setVault(address(vault));
        vm.prank(timelock);
        vault.setStableCoin(address(stableCoin));

        require(collateral.transfer(alice, 100 ether), "transfer failed");
        vm.prank(alice);
        collateral.approve(address(vault), type(uint256).max);
    }

    function test_DepositAndMint_WithinRatio_Succeeds() public {
        vm.startPrank(alice);
        vault.depositCollateral(10 ether); // $20,000 worth
        vault.mintStableCoin(10_000 ether); // 200% ratio — above 150% min
        vm.stopPrank();

        assertEq(stableCoin.balanceOf(alice), 10_000 ether);
        assertEq(vault.currentCollateralRatioBps(alice), 20_000); // 200%
    }

    function test_RevertWhen_MintExceedsMinRatio() public {
        vm.startPrank(alice);
        vault.depositCollateral(1 ether); // $2,000 worth
        vm.expectRevert(Vault.BelowMinCollateralRatio.selector);
        vault.mintStableCoin(1_500 ether); // would be 133% — below 150% min
        vm.stopPrank();
    }

    function test_RevertWhen_WithdrawWouldBreachMinRatio() public {
        vm.startPrank(alice);
        vault.depositCollateral(10 ether);
        vault.mintStableCoin(10_000 ether); // 200% ratio
        vm.expectRevert(Vault.BelowMinCollateralRatio.selector);
        vault.withdrawCollateral(4 ether); // would drop to ~133%
        vm.stopPrank();
    }

    function test_RepayDebt_ReducesDebtAndBurnsToken() public {
        vm.startPrank(alice);
        vault.depositCollateral(10 ether);
        vault.mintStableCoin(5_000 ether);
        vault.repayDebt(2_000 ether);
        vm.stopPrank();

        (, uint256 debtAmount) = vault.positions(alice);
        assertEq(debtAmount, 3_000 ether);
        assertEq(stableCoin.balanceOf(alice), 3_000 ether);
    }

    function test_Liquidation_OnPriceDrop() public {
        vm.startPrank(alice);
        vault.depositCollateral(10 ether); // $20,000
        vault.mintStableCoin(10_000 ether); // 200% ratio
        vm.stopPrank();

        assertFalse(vault.isLiquidatable(alice));

        // Price crashes: collateral now worth $1,000/unit -> ratio drops to 100%
        vm.prank(timelock);
        priceOracle.setPrice(1_000 ether);

        assertTrue(vault.isLiquidatable(alice));

        // Fund the liquidator with dUSD to cover the debt — mint via a
        // second, separate borrower position rather than Vault's
        // privileged mint, to exercise the realistic path (a real
        // liquidator acquires dUSD like anyone else would).
        address funder = makeAddr("funder");
        require(collateral.transfer(funder, 50 ether), "transfer failed");
        vm.startPrank(funder);
        collateral.approve(address(vault), type(uint256).max);
        vault.depositCollateral(50 ether);
        vault.mintStableCoin(5_000 ether);
        require(stableCoin.transfer(liquidatorEoa, 5_000 ether), "transfer failed");
        vm.stopPrank();

        vm.prank(liquidatorEoa);
        uint256 seized = vault.liquidate(alice, 5_000 ether);

        assertGt(seized, 0);
        (, uint256 remainingDebt) = vault.positions(alice);
        assertEq(remainingDebt, 5_000 ether);
        assertEq(collateral.balanceOf(liquidatorEoa), seized);
    }

    function test_RevertWhen_LiquidatingHealthyPosition() public {
        vm.startPrank(alice);
        vault.depositCollateral(10 ether);
        vault.mintStableCoin(5_000 ether); // 400% ratio — very healthy
        vm.stopPrank();

        vm.expectRevert(Vault.PositionNotLiquidatable.selector);
        vault.liquidate(alice, 1_000 ether);
    }

    function test_RevertWhen_PausedBlocksDeposit() public {
        bytes32 pauserRole = vault.PAUSER_ROLE();
        vm.prank(timelock);
        vault.grantRole(pauserRole, timelock);
        vm.prank(timelock);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert();
        vault.depositCollateral(1 ether);
    }

    function test_RevertWhen_NonAdminUpdatesRiskParams() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.updateRiskParams(20_000, 500);
    }
}
