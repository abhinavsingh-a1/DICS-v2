import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import pg from 'pg';

/**
 * Real end-to-end test: deploys InsurancePolicy + ClaimRegistry to a
 * real Anvil chain via Foundry, submits a claim, approves it, pays it
 * out — all as real transactions — then runs this indexer's actual
 * scanContract()/runOnePass() against that chain and asserts the
 * Postgres state matches. Same category of test as oracle-service's
 * real-chain integration test, and same rationale: this is the only way
 * to catch an ABI/event-signature mismatch between this indexer's
 * hand-maintained ABI fragments and the actual deployed contracts.
 *
 * Requires `anvil`, `forge`, and a reachable Postgres (via
 * TEST_DATABASE_URL, defaulting to a local instance) — skips gracefully
 * with a warning if any are unavailable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_CONTRACTS_DIR = path.resolve(__dirname, '../../smart-contracts');
const FIXTURE_PATH = path.join(SMART_CONTRACTS_DIR, 'indexer-fixture.json');
const ANVIL_PORT = 8556;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/dics_indexer_test';

function toolAvailable(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function postgresAvailable() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
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

const CAN_RUN_TOOLS = toolAvailable('anvil') && toolAvailable('forge');
let CAN_RUN = CAN_RUN_TOOLS;
if (!CAN_RUN_TOOLS) {
  // eslint-disable-next-line no-console
  console.warn('[indexer.integration.test] Skipping — anvil and/or forge not found on PATH.');
}

describe('indexer integration (Anvil + real ClaimRegistry/InsurancePolicy)', () => {
  let anvilProcess;
  let deployerWallet;
  let claimantWallet;
  let fixture;
  let pgClient;

  beforeAll(async () => {
    if (CAN_RUN_TOOLS) {
      CAN_RUN = await postgresAvailable();
      if (!CAN_RUN) {
        // eslint-disable-next-line no-console
        console.warn(
          `[indexer.integration.test] Skipping — could not reach Postgres at ${TEST_DATABASE_URL}. ` +
            'Set TEST_DATABASE_URL or run the project docker-compose Postgres locally.'
        );
      }
    }
    if (!CAN_RUN) return;

    deployerWallet = ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, "m/44'/60'/0'/0/0");
    claimantWallet = ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, "m/44'/60'/0'/0/2");

    anvilProcess = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore' });
    await waitForRpc(RPC_URL);

    if (existsSync(FIXTURE_PATH)) rmSync(FIXTURE_PATH);

    execFileSync(
      'forge',
      ['script', 'script/DeployIndexerFixture.s.sol', '--rpc-url', RPC_URL, '--broadcast'],
      {
        cwd: SMART_CONTRACTS_DIR,
        env: {
          ...process.env,
          INTEGRATION_DEPLOYER_PRIVATE_KEY: deployerWallet.privateKey,
          INTEGRATION_CLAIMANT_ADDRESS: claimantWallet.address,
        },
        stdio: 'inherit',
      }
    );

    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

    pgClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await pgClient.connect();
    // Clean slate — drop and let ensureSchema() (called via the module
    // under test) recreate, so repeated local runs of this test don't
    // accumulate stale rows across runs.
    await pgClient.query(
      'DROP TABLE IF EXISTS onchain_events, onchain_claims, onchain_policies, indexer_checkpoints CASCADE'
    );

    process.env.RPC_URL = RPC_URL;
    process.env.CHAIN_ID = String(fixture.chainId);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.CLAIM_REGISTRY_ADDRESS = fixture.claimRegistry;
    process.env.INSURANCE_POLICY_ADDRESS = fixture.insurancePolicy;
    process.env.CLAIM_REGISTRY_DEPLOY_BLOCK = '0';
    process.env.INSURANCE_POLICY_DEPLOY_BLOCK = '0';
    process.env.REORG_SAFETY_BLOCKS = '0'; // Anvil blocks are instantly final; no need to hold back
  }, 30000);

  afterAll(async () => {
    if (anvilProcess) anvilProcess.kill();
    if (pgClient) await pgClient.end();
    if (existsSync(FIXTURE_PATH)) rmSync(FIXTURE_PATH);
  });

  (CAN_RUN_TOOLS ? test : test.skip)(
    'submit → approve → payout is fully reflected in onchain_claims after runOnePass()',
    async () => {
      if (!CAN_RUN) return; // Postgres unavailable — checked in beforeAll, skip at runtime

      const { ensureSchema } = await import('../src/db.js');
      const { runOnePass } = await import('../src/listener.js');

      await ensureSchema();

      // First pass: nothing has happened on-chain yet beyond deployment
      // and policy registration — should index the policy, no claims.
      await runOnePass();
      const afterDeploy = await pgClient.query('SELECT * FROM onchain_policies');
      expect(afterDeploy.rows.length).toBe(1);
      expect(afterDeploy.rows[0].onchain_policy_id).toBe('1');

      // Submit a claim as the claimant
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const claimRegistryAbi = [
        'function submitClaim(uint256 policyId, bytes32 merkleRoot, uint256 amount) external returns (uint256)',
        'function setClaimStatus(uint256 claimId, uint8 status) external',
        'function payoutClaim(uint256 claimId) external',
      ];
      const asClaimant = new ethers.Contract(
        fixture.claimRegistry,
        claimRegistryAbi,
        claimantWallet.connect(provider)
      );
      const asUnderwriter = new ethers.Contract(
        fixture.claimRegistry,
        claimRegistryAbi,
        deployerWallet.connect(provider)
      );

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('evidence-bundle-1'));
      const submitTx = await asClaimant.submitClaim(1, merkleRoot, ethers.parseEther('500'));
      await submitTx.wait();

      await runOnePass();

      const afterSubmit = await pgClient.query('SELECT * FROM onchain_claims WHERE onchain_claim_id = 1');
      expect(afterSubmit.rows.length).toBe(1);
      expect(afterSubmit.rows[0].status).toBe('submitted');
      expect(afterSubmit.rows[0].claimant_address.toLowerCase()).toBe(
        claimantWallet.address.toLowerCase()
      );

      // Approve (ClaimStatus.Approved == 2)
      const approveTx = await asUnderwriter.setClaimStatus(1, 2);
      await approveTx.wait();
      await runOnePass();

      const afterApprove = await pgClient.query('SELECT status FROM onchain_claims WHERE onchain_claim_id = 1');
      expect(afterApprove.rows[0].status).toBe('approved');

      // Payout
      const payoutTx = await asUnderwriter.payoutClaim(1);
      await payoutTx.wait();
      await runOnePass();

      const afterPayout = await pgClient.query(
        'SELECT status, payout_tx_hash FROM onchain_claims WHERE onchain_claim_id = 1'
      );
      expect(afterPayout.rows[0].status).toBe('paid');
      expect(afterPayout.rows[0].payout_tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // Re-running a pass with nothing new on-chain should be a no-op —
      // proves the checkpoint actually advanced and duplicate events
      // aren't reprocessed.
      const { scanned: noopScanned } = (await runOnePass()).claimResult;
      expect(noopScanned).toBe(0);

      const eventCount = await pgClient.query('SELECT count(*) FROM onchain_events');
      // 1 PolicyRegistered + 1 ClaimSubmitted + 1 ClaimStatusChanged + 1 ClaimPayout
      expect(Number(eventCount.rows[0].count)).toBe(4);
    },
    30000
  );
});
