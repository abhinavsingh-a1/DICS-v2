package scheduler

import (
	"testing"
	"time"

	"github.com/aurelia-labs/dics-v2/notification-service/internal/chain"
)

// Table-driven tests are Go's standard idiom — instead of one test
// function per case (which is how the Solidity and Python tests in
// this project are structured), Go convention is usually ONE test
// function containing a slice of {input, expected output} cases,
// looped over. Neither style is "more correct" than the other; this is
// simply what idiomatic Go looks like, worth recognizing as a
// different convention rather than a different testing concept.
func TestShouldNotify(t *testing.T) {
	now := time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)
	warningWindow := 3 * 24 * time.Hour // 3 days, matching WARNING_WINDOW_DAYS default

	cases := []struct {
		name                  string
		status                chain.PremiumStatus
		lastNotifiedPaidUntil int64
		want                  bool
	}{
		{
			name: "premium current — never notify regardless of dates",
			status: chain.PremiumStatus{
				PolicyID:  1,
				Current:   true,
				PaidUntil: now.Add(-24 * time.Hour).Unix(), // even if paidUntil looks "expired", Current=true wins
			},
			want: false,
		},
		{
			name: "premium lapsed, still 10 days out — outside warning window",
			status: chain.PremiumStatus{
				PolicyID:  2,
				Current:   false,
				PaidUntil: now.Add(10 * 24 * time.Hour).Unix(),
			},
			want: false,
		},
		{
			name: "premium lapsed, exactly 2 days out — inside warning window",
			status: chain.PremiumStatus{
				PolicyID:  3,
				Current:   false,
				PaidUntil: now.Add(2 * 24 * time.Hour).Unix(),
			},
			want: true,
		},
		{
			name: "premium already expired in the past — still warn (it's overdue, not just approaching)",
			status: chain.PremiumStatus{
				PolicyID:  4,
				Current:   false,
				PaidUntil: now.Add(-24 * time.Hour).Unix(),
			},
			want: true,
		},
		{
			name: "inside warning window, but already notified for this exact paidUntil — don't repeat",
			status: chain.PremiumStatus{
				PolicyID:  5,
				Current:   false,
				PaidUntil: now.Add(1 * 24 * time.Hour).Unix(),
			},
			lastNotifiedPaidUntil: now.Add(1 * 24 * time.Hour).Unix(), // same value — already warned
			want:                  false,
		},
		{
			name: "inside warning window, previously notified but for a DIFFERENT (older) paidUntil — notify again",
			status: chain.PremiumStatus{
				PolicyID:  6,
				Current:   false,
				PaidUntil: now.Add(1 * 24 * time.Hour).Unix(),
			},
			lastNotifiedPaidUntil: now.Add(-40 * 24 * time.Hour).Unix(), // a much older period's paidUntil
			want:                  true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ShouldNotify(c.status, now, warningWindow, c.lastNotifiedPaidUntil)
			if got != c.want {
				t.Errorf("ShouldNotify() = %v, want %v", got, c.want)
			}
		})
	}
}
