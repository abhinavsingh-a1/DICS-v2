import { ethers } from 'ethers';
import { CLAIM_STATUS_NAMES } from '../src/rpcClient.js';

// Pure unit tests — no chain, no DB. Exercises the ABI fragment and the
// CLAIM_STATUS_NAMES ordering in isolation, specifically to catch the
// class of bug flagged in rpcClient.js's own comment: the array order
// silently determines correctness, with no runtime error if it drifts
// from ClaimRegistry.sol's actual enum order.

describe('CLAIM_STATUS_NAMES ordering', () => {
  test('matches ClaimRegistry.sol ClaimStatus enum order exactly', () => {
    // enum ClaimStatus { Submitted, UnderReview, Approved, Paid, Rejected }
    expect(CLAIM_STATUS_NAMES).toEqual(['submitted', 'under_review', 'approved', 'paid', 'rejected']);
  });
});

describe('event ABI decoding', () => {
  const iface = new ethers.Interface([
    'event ClaimSubmitted(uint256 indexed claimId, uint256 indexed policyId, address indexed claimant, bytes32 merkleRoot, uint256 amount, uint256 timestamp)',
    'event ClaimStatusChanged(uint256 indexed claimId, uint8 status)',
  ]);

  test('encodes and decodes ClaimSubmitted round-trip correctly', () => {
    const claimant = '0x' + '11'.repeat(20);
    const merkleRoot = '0x' + '22'.repeat(32);

    const log = iface.encodeEventLog('ClaimSubmitted', [7n, 1n, claimant, merkleRoot, 500n, 1700000000n]);

    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    expect(parsed.name).toBe('ClaimSubmitted');
    expect(parsed.args.claimId).toBe(7n);
    expect(parsed.args.policyId).toBe(1n);
    expect(parsed.args.claimant.toLowerCase()).toBe(claimant.toLowerCase());
    expect(parsed.args.merkleRoot).toBe(merkleRoot);
    expect(parsed.args.amount).toBe(500n);
  });

  test('decodes ClaimStatusChanged status as a plain number usable as a CLAIM_STATUS_NAMES index', () => {
    const log = iface.encodeEventLog('ClaimStatusChanged', [7n, 2]);
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });

    expect(CLAIM_STATUS_NAMES[parsed.args.status]).toBe('approved');
  });
});
