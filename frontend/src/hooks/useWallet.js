import { useCallback, useState } from 'react';
import { ethers } from 'ethers';

/**
 * Wallet connection + message signing. Deliberately does NOT persist
 * connection state to localStorage — see App.jsx's auth context for the
 * reasoning on why the session token also isn't persisted. Reconnecting
 * on every page load is a minor UX cost accepted for that reason.
 */
export function useWallet() {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError('No wallet extension detected (e.g. MetaMask).');
      return null;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      setAccount(accounts[0]);
      return accounts[0];
    } catch (err) {
      setError(err?.message || 'Wallet connection was rejected.');
      return null;
    }
  }, []);

  const getSigner = useCallback(async () => {
    if (!window.ethereum) throw new Error('No wallet extension detected.');
    const provider = new ethers.BrowserProvider(window.ethereum);
    return provider.getSigner();
  }, []);

  const signMessage = useCallback(
    async (message) => {
      const signer = await getSigner();
      try {
        return await signer.signMessage(message);
      } catch (err) {
        throw new Error(err?.message || 'Signature request was rejected.');
      }
    },
    [getSigner]
  );

  return { account, error, connect, getSigner, signMessage };
}
