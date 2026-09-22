// Package db is a READ-ONLY connection to the indexer's own Postgres
// tables — this service never writes to onchain_policies, only queries
// it, for the same "two services should not both own migrations for
// the same table" reason documented in indexer/README.md's "Ownership
// boundary" section. This service adds no new tables to that schema.
package db

import (
	"context"
	"database/sql"

	_ "github.com/lib/pq" // registers the "postgres" driver; used only for its side effect
)

type Policy struct {
	PolicyID      int64
	HolderAddress string
	Revoked       bool
}

type DB struct {
	conn *sql.DB
}

func Connect(databaseURL string) (*DB, error) {
	conn, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, err
	}
	if err := conn.Ping(); err != nil {
		return nil, err
	}
	return &DB{conn: conn}, nil
}

func (d *DB) Close() error {
	return d.conn.Close()
}

// ActivePolicies returns every non-revoked policy the indexer knows
// about. Deliberately excludes revoked ones — a revoked policy can
// never be claimed against regardless of premium status (see
// InsurancePolicy.sol's isClaimEligible), so reminding someone to pay
// a premium on a policy that's revoked either way would be actively
// misleading, not just unnecessary.
func (d *DB) ActivePolicies(ctx context.Context) ([]Policy, error) {
	rows, err := d.conn.QueryContext(ctx,
		`SELECT onchain_policy_id, holder_address, revoked
		 FROM onchain_policies
		 WHERE revoked = false`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var policies []Policy
	for rows.Next() {
		var p Policy
		if err := rows.Scan(&p.PolicyID, &p.HolderAddress, &p.Revoked); err != nil {
			return nil, err
		}
		policies = append(policies, p)
	}
	return policies, rows.Err()
}
