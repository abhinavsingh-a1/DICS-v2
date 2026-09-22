import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import request from 'supertest';

/**
 * Real end-to-end integration test: spins up Anvil, deploys a REAL
 * OracleAdapter (behind a proxy) + mock ClaimRegistry sink via Foundry,
 * then exercises this service's actual HTTP endpoint and signing/relay
 * code against that live chain.
 *
 * This is what signer.test.js explicitly could NOT do — signer.test.js
 * only proves this service's signing logic is internally consistent with
 * itself. This test proves it's consistent with the actual deployed
 * contract's EIP-712 domain, and proves replay/expiry protection holds
 * against a real chain, not just against Foundry's own test suite in
 * isolation.
 *
 * Requires `anvil` and `forge` on PATH. Skips (not fails) if unavailable,
 * with a console warning — this keeps `npm test` usable without Foundry
 * installed, while `npm run test:integration` is the explicit, CI-only
 * invocation that requires the tooling to be present.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_CONTRACTS_DIR = path.resolve(__dirname, '../../smart-contracts');
const FIXTURE_PATH = path.join(SMART_CONTRACTS_DIR, 'integration-fixture.json');
const ANVIL_PORT = 8555;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil/Hardhat's well-known default test mnemonic — publicly documented,
// deliberately insecure, used only to derive deterministic local test
// accounts. Deriving from the mnemonic here rather than hardcoding a hex
// private key avoids the exact class of hand-copied-constant mistake
// this project has already caught and avoided once (see OracleAdapter.sol's
// typehash comment).
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

function toolAvailable(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = toolAvailable('anvil') && toolAvailable('forge');
if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    '[oracle.integration.test] Skipping — anvil and/or forge not found on PATH. ' +
      'Install Foundry (https://getfoundry.sh) to run this test suite.'
  );
}

async function waitForRpc(url, timeoutMs = 15000) {
  const start = Date.now();
  const provider = new ethers.JsonRpcProvider(url);
  while (Date.now() - start < timeoutMs) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Anvil did not become reachable at ${url} within ${timeoutMs}ms`);
}

(CAN_RUN ? describe : describe.skip)('oracle-service integration (Anvil + real OracleAdapter)', () => {
  let anvilProcess;
  let signerWallet;
  let relayerWallet;
  let fixture;
  let serverApp;

  beforeAll(async () => {
    signerWallet = ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, "m/44'/60'/0'/0/0");
    relayerWallet = ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, "m/44'/60'/0'/0/1");

    anvilProcess = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'], {
      stdio: 'ignore',
    });
    await waitForRpc(RPC_URL);

    if (existsSync(FIXTURE_PATH)) rmSync(FIXTURE_PATH);

    execFileSync(
      'forge',
      ['script', 'script/DeployIntegrationFixture.s.sol', '--rpc-url', RPC_URL, '--broadcast'],
      {
        cwd: SMART_CONTRACTS_DIR,
        env: {
          ...process.env,
          INTEGRATION_DEPLOYER_PRIVATE_KEY: signerWallet.privateKey,
          INTEGRATION_ORACLE_SIGNER: signerWallet.address,
          INTEGRATION_RESPONSE_VALIDITY_WINDOW: '300',
        },
        stdio: 'inherit',
      }
    );

    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

    // Set env BEFORE importing config/server — config.js reads
    // process.env at module-load time, and dotenv's default behavior
    // does not overwrite already-set variables, so these values take
    // precedence over any .env file present in this working directory.
    process.env.RPC_URL = RPC_URL;
    process.env.CHAIN_ID = String(fixture.chainId);
    process.env.ORACLE_ADAPTER_ADDRESS = fixture.oracleAdapter;
    process.env.ORACLE_SIGNER_PRIVATE_KEY = signerWallet.privateKey;
    process.env.RELAYER_PRIVATE_KEY = relayerWallet.privateKey;
    process.env.EIP712_DOMAIN_NAME = 'DICS-OracleAdapter';
    process.env.EIP712_DOMAIN_VERSION = '1';
    process.env.PORT = '4199';
    process.env.ORACLE_SERVICE_API_KEY = 'integration-test-key-' + '0'.repeat(16);

    const serverModule = await import('../src/server.js');
    serverApp = serverModule.app;
  }, 30000);

  afterAll(() => {
    if (anvilProcess) anvilProcess.kill();
    if (existsSync(FIXTURE_PATH)) rmSync(FIXTURE_PATH);
  });

  test('POST /verify signs, relays, and the real OracleAdapter forwards to the sink', async () => {
    const res = await request(serverApp)
      .post('/verify')
      .set('X-Oracle-Service-Key', process.env.ORACLE_SERVICE_API_KEY)
      .send({ claimId: 7, declaredAmount: 250 })
      .expect(200);

    expect(res.body.approved).toBe(true);
    expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const sinkAbi = [
      'function lastClaimId() view returns (uint256)',
      'function lastApproved() view returns (bool)',
      'function callCount() view returns (uint256)',
    ];
    const sink = new ethers.Contract(fixture.claimRegistrySink, sinkAbi, provider);

    expect(await sink.callCount()).toBe(1n);
    expect(await sink.lastClaimId()).toBe(7n);
    expect(await sink.lastApproved()).toBe(true);
  });

  test('MOCK verification logic rejects a claim over the placeholder threshold, and OracleAdapter still records the rejection on-chain', async () => {
    const res = await request(serverApp)
      .post('/verify')
      .set('X-Oracle-Service-Key', process.env.ORACLE_SERVICE_API_KEY)
      .send({ claimId: 8, declaredAmount: 500_000 })
      .expect(200);

    expect(res.body.approved).toBe(false);

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const sinkAbi = [
      'function lastClaimId() view returns (uint256)',
      'function lastApproved() view returns (bool)',
    ];
    const sink = new ethers.Contract(fixture.claimRegistrySink, sinkAbi, provider);
    expect(await sink.lastClaimId()).toBe(8n);
    expect(await sink.lastApproved()).toBe(false);
  });

  test('POST /verify without the API key is rejected before any signing or chain call happens', async () => {
    const res = await request(serverApp)
      .post('/verify')
      .send({ claimId: 999, declaredAmount: 100 })
      .expect(401);

    expect(res.body.error).toBe('missing_api_key');

    // Confirm no on-chain call happened for this claimId — the sink's
    // callCount from the earlier two successful tests should be
    // unchanged (still 2, not 3), proving the middleware actually
    // short-circuited before reaching signing/relay logic.
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const sinkAbi = ['function callCount() view returns (uint256)'];
    const sink = new ethers.Contract(fixture.claimRegistrySink, sinkAbi, provider);
    expect(await sink.callCount()).toBe(2n);
  });

  test('replaying the exact same signed response reverts on-chain the second time', async () => {
    const { signOracleResponse } = await import('../src/signer.js');
    const { submitVerificationOnChain } = await import('../src/chainClient.js');
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const payload = {
      claimId: 99,
      requestId: ethers.hexlify(ethers.randomBytes(32)),
      approved: true,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const signature = await signOracleResponse(signerWallet.connect(provider), payload);

    await submitVerificationOnChain(payload, signature); // first attempt succeeds

    await expect(submitVerificationOnChain(payload, signature)).rejects.toThrow();
  });

  test('an expired signed response is rejected on-chain after advancing real block time', async () => {
    const { signOracleResponse } = await import('../src/signer.js');
    const { submitVerificationOnChain } = await import('../src/chainClient.js');
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const payload = {
      claimId: 100,
      requestId: ethers.hexlify(ethers.randomBytes(32)),
      approved: true,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const signature = await signOracleResponse(signerWallet.connect(provider), payload);

    // Validity window is 300s (INTEGRATION_RESPONSE_VALIDITY_WINDOW) —
    // advance real Anvil block time well past it.
    await provider.send('evm_increaseTime', [400]);
    await provider.send('evm_mine', []);

    await expect(submitVerificationOnChain(payload, signature)).rejects.toThrow();
  });

  test('a response signed by an address without ORACLE_SIGNER_ROLE is rejected on-chain', async () => {
    const { signOracleResponse } = await import('../src/signer.js');
    const { submitVerificationOnChain } = await import('../src/chainClient.js');
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const unauthorizedWallet = ethers.Wallet.createRandom().connect(provider);
    // fund it so the revert we get is the role check, not "insufficient funds"
    await relayerWallet.connect(provider).sendTransaction({
      to: unauthorizedWallet.address,
      value: ethers.parseEther('1'),
    });

    const payload = {
      claimId: 101,
      requestId: ethers.hexlify(ethers.randomBytes(32)),
      approved: true,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const signature = await signOracleResponse(unauthorizedWallet, payload);

    await expect(submitVerificationOnChain(payload, signature)).rejects.toThrow();
  });
});
