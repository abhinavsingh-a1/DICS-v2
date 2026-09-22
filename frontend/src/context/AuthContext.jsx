import React, { createContext, useContext, useState, useCallback } from 'react';
import { useWallet } from '../hooks/useWallet.js';
import { getNonce, loginWallet } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * Deliberately in-memory only (React state), not localStorage —
 * consistent with the project's stated posture elsewhere (backend JWTs
 * are short-lived, oracle-service/indexer secrets never touch client-
 * side storage). A page refresh requires re-authenticating; accepted as
 * a UX cost in exchange for not persisting a bearer token in a location
 * readable by any injected script (XSS blast radius).
 */
export function AuthProvider({ children }) {
  const wallet = useWallet();
  const [token, setToken] = useState(null);
  const [loginError, setLoginError] = useState(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const login = useCallback(async () => {
    setLoginError(null);
    setLoggingIn(true);
    try {
      const address = wallet.account || (await wallet.connect());
      if (!address) throw new Error('Wallet not connected.');

      const nonceRes = await getNonce(address);
      const { message } = nonceRes.data;

      const signature = await wallet.signMessage(message);

      const loginRes = await loginWallet(address, signature);
      setToken(loginRes.data.access_token);
    } catch (err) {
      setLoginError(err?.response?.data?.detail || err?.message || 'Login failed.');
      setToken(null);
    } finally {
      setLoggingIn(false);
    }
  }, [wallet]);

  const logout = useCallback(() => setToken(null), []);

  return (
    <AuthContext.Provider
      value={{
        account: wallet.account,
        token,
        isAuthenticated: Boolean(token),
        login,
        logout,
        loginError,
        loggingIn,
        walletError: wallet.error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
