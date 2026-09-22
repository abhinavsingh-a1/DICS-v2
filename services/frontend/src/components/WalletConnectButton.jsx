import React from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function WalletConnectButton() {
  const { account, isAuthenticated, login, logout, loggingIn, loginError, walletError } = useAuth();

  if (isAuthenticated) {
    return (
      <span>
        {account.slice(0, 6)}...{account.slice(-4)} <button onClick={logout}>Log out</button>
      </span>
    );
  }

  return (
    <span>
      <button onClick={login} disabled={loggingIn}>
        {loggingIn ? 'Connecting…' : 'Connect Wallet'}
      </button>
      {(loginError || walletError) && <div className="error">{loginError || walletError}</div>}
    </span>
  );
}
