// Package config reads and validates environment configuration once at
// startup — same "fail loudly, immediately, before anything else runs"
// principle used throughout this project (oracle-service's config.js,
// the backend's config.py). Go has no built-in equivalent of
// pydantic-settings, so this is written out by hand: read each
// required variable, and if any is missing, stop the whole program
// with a clear message rather than let a nil/empty value cause a
// confusing failure three function calls later.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	RPCURL                 string
	InsurancePolicyAddress string
	DatabaseURL            string
	WebhookURL             string
	PollInterval           time.Duration
	WarningWindow          time.Duration
}

// Load reads every required variable and returns an error naming
// EXACTLY which one is missing, rather than a generic "config invalid"
// — the same reasoning behind every other service's config validation
// in this project: a missing INSURANCE_POLICY_ADDRESS should never be
// discovered as a mysterious nil-pointer panic deep inside chain.go.
func Load() (*Config, error) {
	cfg := &Config{
		RPCURL:                 os.Getenv("RPC_URL"),
		InsurancePolicyAddress: os.Getenv("INSURANCE_POLICY_ADDRESS"),
		DatabaseURL:            os.Getenv("DATABASE_URL"),
		WebhookURL:             os.Getenv("WEBHOOK_URL"),
	}

	for name, value := range map[string]string{
		"RPC_URL":                  cfg.RPCURL,
		"INSURANCE_POLICY_ADDRESS": cfg.InsurancePolicyAddress,
		"DATABASE_URL":             cfg.DatabaseURL,
		"WEBHOOK_URL":              cfg.WebhookURL,
	} {
		if value == "" {
			return nil, fmt.Errorf("required environment variable %s is not set", name)
		}
	}

	pollSeconds, err := envIntOrDefault("POLL_INTERVAL_SECONDS", 300)
	if err != nil {
		return nil, err
	}
	cfg.PollInterval = time.Duration(pollSeconds) * time.Second

	warningDays, err := envIntOrDefault("WARNING_WINDOW_DAYS", 3)
	if err != nil {
		return nil, err
	}
	cfg.WarningWindow = time.Duration(warningDays) * 24 * time.Hour

	return cfg, nil
}

func envIntOrDefault(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer, got %q", name, raw)
	}
	return value, nil
}
