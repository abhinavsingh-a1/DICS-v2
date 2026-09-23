/**
 * Bridges a KmsSigner (an ethers.js Signer) into the EIP-1193 provider
 * interface `@safe-global/protocol-kit` actually expects to be handed.
 *
 * Why this exists at all, stated directly: protocol-kit's documented
 * `signer` option wants either a raw private key string or an address
 * that its `provider` can already sign for (the same shape a browser
 * extension wallet satisfies — that's what protocol-kit was originally
 * built around). There is no direct "pass in a custom Signer object"
 * option in the versions this project targets. Rather than force
 * KmsSigner's private key OUT of KMS just to satisfy that interface —
 * which would defeat the entire point of using KMS — this file makes
 * KmsSigner itself LOOK like a browser wallet's `window.ethereum` from
 * protocol-kit's point of view, implementing exactly the handful of
 * JSON-RPC methods a Safe transaction flow actually calls.
 *
 * VERSION CAVEAT, stated as plainly as every other unverified piece of
 * this project: this adapter was written against my best understanding
 * of protocol-kit v4.x's expected provider shape, without the ability
 * to run `npm install` and check against the real installed package's
 * TypeScript types in this environment. If Safe.init() rejects this
 * object or calls a method not implemented below, that's the concrete
 * signal of exactly what's missing — treat any such error as expected
 * verification work, the same way every "not independently compiled"
 * caveat elsewhere in this project has turned out to need at least one
 * real correction round once actually run.
 */
class Eip1193FromKmsSigner {
  constructor(kmsSigner, jsonRpcProvider, chainId) {
    this.signer = kmsSigner;
    this.rpcProvider = jsonRpcProvider;
    this.chainId = chainId;
    this._address = null;
  }

  async request({ method, params }) {
    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts': {
        const address = await this._getAddress();
        return [address];
      }

      case 'eth_chainId':
        return '0x' + this.chainId.toString(16);

      case 'personal_sign': {
        // params: [messageHex, address] — Safe's SDK sends the message
        // as hex-encoded bytes for this method, not a plain string, so
        // it's decoded back to a UTF-8-agnostic byte string ethers'
        // signMessage can hash correctly either way (signMessage accepts
        // both a string and raw bytes).
        const [messageHex] = params;
        const messageBytes = Buffer.from(messageHex.slice(2), 'hex');
        return this.signer.signMessage(messageBytes);
      }

      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJsonString] — this is exactly how
        // a Safe transaction's own EIP-712 hash gets signed by each
        // owner (see docs/services' Safe design doc for what this typed
        // data actually represents: a SafeTx struct, structurally
        // similar in spirit to OracleAdapter's own EIP-712 usage
        // elsewhere in this project, just Safe's own schema).
        const [, typedDataJson] = params;
        const typedData = JSON.parse(typedDataJson);
        const { EIP712Domain, ...types } = typedData.types; // ethers derives the domain separator itself; passing EIP712Domain as a type too would double-count it
        return this.signer.signTypedData(typedData.domain, types, typedData.message);
      }

      case 'eth_sendTransaction': {
        const [txParams] = params;
        const tx = await this.signer.sendTransaction({
          to: txParams.to,
          data: txParams.data,
          value: txParams.value || 0n,
        });
        return tx.hash;
      }

      default:
        // Every other method (eth_call, eth_getTransactionReceipt,
        // eth_estimateGas, etc.) is a plain read or a query about
        // already-broadcast transactions — none of that needs signing,
        // so it's simply forwarded to the real underlying RPC provider
        // rather than reimplemented here.
        return this.rpcProvider.send(method, params || []);
    }
  }

  async _getAddress() {
    if (!this._address) {
      this._address = await this.signer.getAddress();
    }
    return this._address;
  }
}

module.exports = { Eip1193FromKmsSigner };
