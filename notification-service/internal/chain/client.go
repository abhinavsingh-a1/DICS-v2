// Package chain wraps the two read-only calls this service needs
// against InsurancePolicy — isPremiumCurrent and premiumPaidUntil.
// Same hand-maintained-minimal-ABI approach used everywhere else in
// this project (the Python backend's web3_client.py, the frontend's
// contract.js, oracle-service's chainClient.js): only the functions
// actually used are declared here, not the contract's full ABI, so it
// stays obvious by inspection that this client can only ever read.
package chain

import (
	"context"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Same JSON-ABI-fragment shape as the Python backend's
// INSURANCE_POLICY_ABI (web3_client.py) — go-ethereum's abi.JSON parses
// this exact format, same as web3.py does. Keeping the two hand-written
// ABI fragments in different languages structurally identical to each
// other makes it easy to spot if one drifts out of sync with the real
// contract while the other doesn't.
const insurancePolicyABIJSON = `[
  {"name":"isPremiumCurrent","type":"function","stateMutability":"view",
   "inputs":[{"name":"policyId","type":"uint256"}],
   "outputs":[{"name":"","type":"bool"}]},
  {"name":"premiumPaidUntil","type":"function","stateMutability":"view",
   "inputs":[{"name":"policyId","type":"uint256"}],
   "outputs":[{"name":"","type":"uint256"}]}
]`

type Client struct {
	eth             *ethclient.Client
	contractABI     abi.ABI
	contractAddress common.Address
}

func NewClient(rpcURL string, insurancePolicyAddress string) (*Client, error) {
	ethClient, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, err
	}

	parsedABI, err := abi.JSON(strings.NewReader(insurancePolicyABIJSON))
	if err != nil {
		return nil, err
	}

	return &Client{
		eth:             ethClient,
		contractABI:     parsedABI,
		contractAddress: common.HexToAddress(insurancePolicyAddress),
	}, nil
}

// call is the one place that actually talks to the chain — both
// PremiumStatus's fields go through this same helper, so there's a
// single implementation of "encode a view-function call, send it,
// decode the result" rather than two near-duplicate copies that could
// drift apart from each other over time.
func (c *Client) call(ctx context.Context, method string, out interface{}, args ...interface{}) error {
	data, err := c.contractABI.Pack(method, args...)
	if err != nil {
		return err
	}

	result, err := c.eth.CallContract(ctx, ethereum.CallMsg{
		To:   &c.contractAddress,
		Data: data,
	}, nil) // nil block number = read against the latest block
	if err != nil {
		return err
	}

	return c.contractABI.UnpackIntoInterface(out, method, result)
}

type PremiumStatus struct {
	PolicyID     int64
	Current      bool
	PaidUntil    int64 // unix timestamp
}

// GetPremiumStatus makes the two chain reads for one policy ID and
// returns them combined — mirroring the Python backend's
// GET /policies/{id}/status, just as a direct chain read here instead
// of an HTTP call, since this service already has its own RPC
// connection and doesn't need to go through the backend for this.
func (c *Client) GetPremiumStatus(ctx context.Context, policyID int64) (*PremiumStatus, error) {
	var current bool
	if err := c.call(ctx, "isPremiumCurrent", &current, big.NewInt(policyID)); err != nil {
		return nil, err
	}

	var paidUntilBig *big.Int
	if err := c.call(ctx, "premiumPaidUntil", &paidUntilBig, big.NewInt(policyID)); err != nil {
		return nil, err
	}

	return &PremiumStatus{
		PolicyID:  policyID,
		Current:   current,
		PaidUntil: paidUntilBig.Int64(),
	}, nil
}
