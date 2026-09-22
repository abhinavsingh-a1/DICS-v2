import React from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import WalletConnectButton from './components/WalletConnectButton.jsx';
import Dashboard from './pages/Dashboard.jsx';
import BuyPolicy from './pages/BuyPolicy.jsx';
import FileClaim from './pages/FileClaim.jsx';
import ClaimStatus from './pages/ClaimStatus.jsx';

function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return (
      <div className="card">
        <p>Connect your wallet to continue.</p>
      </div>
    );
  }
  return children;
}

function Shell() {
  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>DICS v2</h1>
          <nav>
            <Link to="/">Dashboard</Link>
            <Link to="/buy-policy">Buy a Policy</Link>
            <Link to="/file-claim">File a Claim</Link>
            <Link to="/claim-status">Claim Status</Link>
          </nav>
        </div>
        <WalletConnectButton />
      </header>
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/buy-policy"
            element={
              // Deliberately NOT wrapped in RequireAuth — browsing plans
              // and subscribing both work from a connected wallet alone;
              // neither needs the backend's JWT session (see
              // BuyPolicy.jsx and policies_routes.py's docstrings on why
              // these reads are unauthenticated, and contract.js on why
              // subscribing is a direct wallet transaction, not a
              // backend-authenticated call).
              <BuyPolicy />
            }
          />
          <Route
            path="/file-claim"
            element={
              <RequireAuth>
                <FileClaim />
              </RequireAuth>
            }
          />
          <Route
            path="/claim-status"
            element={
              <RequireAuth>
                <ClaimStatus />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
