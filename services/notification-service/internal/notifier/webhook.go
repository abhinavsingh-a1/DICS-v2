// Package notifier sends a real HTTP POST to a configurable webhook —
// genuinely functional against any webhook receiver (a Slack incoming
// webhook, a simple test HTTP endpoint, anything that accepts a JSON
// POST), not a "print and pretend" placeholder. What's NOT built here,
// stated directly: an actual email/SMS integration — that would need a
// real provider account (SendGrid, Twilio, etc.) this project has no
// reason to hold credentials for. A webhook is the honest stand-in,
// the same way MockOracle/placeholderMerkleRoot stand in for pieces
// this project deliberately doesn't build a full real integration for.
package notifier

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type PremiumWarning struct {
	PolicyID      int64  `json:"policy_id"`
	HolderAddress string `json:"holder_address"`
	PaidUntil     int64  `json:"premium_paid_until"`
	DaysRemaining int    `json:"days_remaining"`
}

type WebhookNotifier struct {
	url        string
	httpClient *http.Client
}

func NewWebhookNotifier(url string) *WebhookNotifier {
	return &WebhookNotifier{
		url:        url,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (n *WebhookNotifier) Send(ctx context.Context, warning PremiumWarning) error {
	body, err := json.Marshal(warning)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := n.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d for policy %d", resp.StatusCode, warning.PolicyID)
	}
	return nil
}
