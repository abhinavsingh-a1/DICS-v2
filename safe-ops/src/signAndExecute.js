/**
 * Shared by every script that needs a Safe transaction actually signed
 * by enough owners and executed — factored out once specifically so
 * 04/05/06 can't quietly drift into three slightly different signing
 * loops over time (the same reasoning behind every other "one shared
 * helper" choice in this project, e.g. notification-service's `call`
 * function in chain/client.go).
 */
const { KMSClient } = require('@aws-sdk/client-kms');
const Safe = require('@safe-global/protocol-kit').default;
const { KmsSigner } = require('./kmsSigner');

/**
 * @param {object} config From loadConfig()
 * @param {import('ethers').Provider} provider
 * @param {import('@safe-global/protocol-kit').SafeTransaction} unsignedSafeTransaction
 * @returns {Promise<{hash: string}>}
 */
async function signAndExecute(config, provider, unsignedSafeTransaction) {
  const kmsClient = new KMSClient({ region: config.awsRegion });

  const executorSigner = new KmsSigner(kmsClient, config.ownerKmsKeyIds[0], provider);
  const executorProtocolKit = await Safe.init({
    provider: config.rpcUrl,
    signer: await executorSigner.getAddress(),
    safeAddress: config.safeAddress,
  });

  const threshold = await executorProtocolKit.getThreshold();
  console.log(`Safe threshold: ${threshold}. Collecting signatures from ${threshold} owner(s)...`);

  let signedTransaction = unsignedSafeTransaction;
  for (let i = 0; i < threshold; i++) {
    const ownerSigner = new KmsSigner(kmsClient, config.ownerKmsKeyIds[i], provider);
    const ownerAddress = await ownerSigner.getAddress();
    const ownerProtocolKit = await Safe.init({
      provider: config.rpcUrl,
      signer: ownerAddress,
      safeAddress: config.safeAddress,
    });
    signedTransaction = await ownerProtocolKit.signTransaction(signedTransaction);
    console.log(`  signed by owner ${i + 1}/${threshold}: ${ownerAddress}`);
  }

  console.log('Executing...');
  const executeTxResponse = await executorProtocolKit.executeTransaction(signedTransaction);
  const receipt = await executeTxResponse.transactionResponse?.wait?.();
  const hash = receipt?.hash || executeTxResponse.hash;
  console.log(`Executed. Transaction: ${hash}`);
  return { hash };
}

module.exports = { signAndExecute };
