package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/aurelia-labs/dics-v2/notification-service/internal/chain"
	"github.com/aurelia-labs/dics-v2/notification-service/internal/config"
	"github.com/aurelia-labs/dics-v2/notification-service/internal/db"
	"github.com/aurelia-labs/dics-v2/notification-service/internal/notifier"
	"github.com/aurelia-labs/dics-v2/notification-service/internal/scheduler"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	chainClient, err := chain.NewClient(cfg.RPCURL, cfg.InsurancePolicyAddress)
	if err != nil {
		log.Fatalf("chain client error: %v", err)
	}

	database, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database connection error: %v", err)
	}
	defer database.Close()

	webhookNotifier := notifier.NewWebhookNotifier(cfg.WebhookURL)

	s := scheduler.New(
		scheduler.Config{PollInterval: cfg.PollInterval, WarningWindow: cfg.WarningWindow},
		chainClient,
		database,
		webhookNotifier,
	)

	// Cancels the scheduler's loop cleanly on SIGINT/SIGTERM (Ctrl+C
	// locally, or Docker's stop signal in a container) instead of the
	// process just being killed mid-check.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("notification-service started — polling every %s, warning window %s", cfg.PollInterval, cfg.WarningWindow)
	s.Run(ctx)
	log.Println("notification-service shut down")
}
