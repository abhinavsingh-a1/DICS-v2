import { ethers } from 'ethers';
import { signOracleResponse, recoverSigner } from '../src/signer.js';

// These tests exercise pure signing/recovery logic — no chain connection
// needed. This is deliberately NOT a substitute for an integration test
// against a real deployed OracleAdapter (see README "still open"); it
// catches domain/type-definition bugs in this service's own code, but
// cannot catch a mismatch against the actual on-chain contract's
// EIP712_init values — only an integration test against a real
// deployment can catch that class of bug.

describe('signOracleResponse / recoverSigner', () => {
  const wallet = ethers.Wallet.createRandom();

  const payload = {
    claimId: 42,
    requestId: '0x' + '11'.repeat(32),
    approved: true,
    timestamp: Math.floor(Date.now() / 1000),
  };

  test('recovers the same address that signed', async () => {
    const signature = await signOracleResponse(wallet, payload);
    const recovered = recoverSigner(payload, signature);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  test('recovers a DIFFERENT address if any payload field changes', async () => {
    const signature = await signOracleResponse(wallet, payload);
    const tamperedPayload = { ...payload, approved: !payload.approved };
    const recovered = recoverSigner(tamperedPayload, signature);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  test('recovers a DIFFERENT address if requestId changes', async () => {
    const signature = await signOracleResponse(wallet, payload);
    const tamperedPayload = { ...payload, requestId: '0x' + '22'.repeat(32) };
    const recovered = recoverSigner(tamperedPayload, signature);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });
});
