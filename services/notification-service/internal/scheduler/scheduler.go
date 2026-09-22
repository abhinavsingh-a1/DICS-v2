// Package scheduler runs the periodic check loop and decides which
// policies need a warning sent.
package scheduler

import (
	"context"
	"log"
	"time"

	"github.com/aurelia-labs/dics-v2/notification-service/internal/chain"
	"github.com/aurelia-labs/dics-v2/notification-service/internal/db"
	"github.com/aurelia-labs/dics-v2/notification-service/internal/notifier"
)

// ShouldNotify is deliberately a pure function — no chain call, no
// database, no HTTP, just: given what we already know, should THIS
// policy get a warning right now? Pulling this decision out of the
// loop that actually performs I/O is what makes it possible to test
// every edge case (see scheduler_test.go) in milliseconds, with no
// database or blockchain running at all — the same reason the Python
// backend's tests mock get_insurance_policy_contract rather than
// hitting a real chain (see docs/tests-explained/12).
func ShouldNotify(status chain.PremiumStatus, now time.Time, warningWindow time.Duration, lastNotifiedPaidUntil int64) bool {
	if status.Current {
		return false // premium is fine, nothing to warn about
	}

	paidUntil := time.Unix(status.PaidUntil, 0)
	withinWarningWindow := now.After(paidUntil.Add(-warningWindow))
	if !withinWarningWindow {
		return false // still comfortably ahead of expiry, not yet time to warn
	}

	// Already warned about THIS SPECIFIC paid-until value — don't send
	// the same warning again every single poll interval until the
	// person finally pays. Once they DO pay, paidUntil changes to a new
	// future value, lastNotifiedPaidUntil no longer matches it, and a
	// fresh warning cycle becomes possible again for the new period.
	if status.PaidUntil == lastNotifiedPaidUntil {
		return false
	}

	return true
}

type Scheduler struct {
	cfg      Config
	chain    *chain.Client
	database *db.DB
	notify   *notifier.WebhookNotifier

	// In-memory de-dup tracking, keyed by policy ID — deliberately NOT
	// persisted to a database table. A real production version of this
	// service would want that persisted (a restart could re-send one
	// already-sent warning) — an acknowledged, honest simplification,
	// not an oversight: the actual harm of an occasional duplicate
	// warning after a restart is low, and adding a new table just to
	// avoid it wasn't judged worth the schema-ownership question it
	// would raise (see db/policies.go's header on why this service
	// doesn't write to the indexer's schema at all).
	lastNotified map[int64]int64
}

type Config struct {
	PollInterval  time.Duration
	WarningWindow time.Duration
}

func New(cfg Config, chainClient *chain.Client, database *db.DB, notify *notifier.WebhookNotifier) *Scheduler {
	return &Scheduler{
		cfg:          cfg,
		chain:        chainClient,
		database:     database,
		notify:       notify,
		lastNotified: make(map[int64]int64),
	}
}

// Run blocks forever, checking every active policy once per
// cfg.PollInterval, until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.PollInterval)
	defer ticker.Stop()

	s.checkOnce(ctx) // check immediately on startup, don't wait for the first tick
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.checkOnce(ctx)
		}
	}
}

func (s *Scheduler) checkOnce(ctx context.Context) {
	policies, err := s.database.ActivePolicies(ctx)
	if err != nil {
		log.Printf("checkOnce: failed to load policies: %v", err)
		return
	}

	for _, p := range policies {
		status, err := s.chain.GetPremiumStatus(ctx, p.PolicyID)
		if err != nil {
			log.Printf("checkOnce: policy %d: chain read failed: %v", p.PolicyID, err)
			continue // one policy's chain error shouldn't stop the whole batch
		}

		if !ShouldNotify(*status, time.Now(), s.cfg.WarningWindow, s.lastNotified[p.PolicyID]) {
			continue
		}

		daysRemaining := int(time.Until(time.Unix(status.PaidUntil, 0)).Hours() / 24)
		warning := notifier.PremiumWarning{
			PolicyID:      p.PolicyID,
			HolderAddress: p.HolderAddress,
			PaidUntil:     status.PaidUntil,
			DaysRemaining: daysRemaining,
		}

		if err := s.notify.Send(ctx, warning); err != nil {
			log.Printf("checkOnce: policy %d: notification failed: %v", p.PolicyID, err)
			continue // don't mark as notified if sending actually failed
		}

		s.lastNotified[p.PolicyID] = status.PaidUntil
		log.Printf("checkOnce: sent premium warning for policy %d (%d days remaining)", p.PolicyID, daysRemaining)
	}
}
