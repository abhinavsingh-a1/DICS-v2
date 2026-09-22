import { jest } from '@jest/globals';

// config.js validates env at import time, so set a valid environment
// BEFORE importing anything that transitively imports config.js — same
// constraint documented in the integration test.
process.env.RPC_URL = 'http://127.0.0.1:8545';
process.env.CHAIN_ID = '1337';
process.env.ORACLE_ADAPTER_ADDRESS = '0x' + '11'.repeat(20);
process.env.ORACLE_SIGNER_PRIVATE_KEY = '0x' + '22'.repeat(32);
process.env.EIP712_DOMAIN_NAME = 'DICS-OracleAdapter';
process.env.EIP712_DOMAIN_VERSION = '1';
process.env.ORACLE_SERVICE_API_KEY = 'a'.repeat(32);

const { requireApiKey } = await import('../src/auth.js');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireApiKey middleware', () => {
  test('rejects a request with no key header', () => {
    const req = { header: () => undefined };
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a request with the wrong key', () => {
    const req = { header: () => 'b'.repeat(32) };
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a request with a key of a different length', () => {
    const req = { header: () => 'short-key' };
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() for the correct key', () => {
    const req = { header: () => 'a'.repeat(32) };
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
