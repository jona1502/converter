package jobs

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// SetFreeBytes ersetzt die Abfrage des freien Platzes (nur Tests).
func SetFreeBytes(s *Service, f func() (uint64, error)) { s.freeBytes = f }

func SetFinalizeTx(s *Service, f func(context.Context, func(pgx.Tx) error) error) { s.finalizeTx = f }
