package httpapi

import (
	"context"
	"io"
	"log/slog"
)

// Felder, die in eine Logzeile gelangen dürfen (wie ALLOWED_EXTRA_FIELDS in
// backend/app/core/logs.py, ergänzt um "stack" für Panics). Alles andere –
// Bodies, Header, Cookies, Query, Dateinamen, Fehlertexte – wird verworfen,
// auch wenn es versehentlich übergeben wird.
var allowedLogKeys = map[string]bool{
	"requestId":  true,
	"method":     true,
	"route":      true,
	"status":     true,
	"durationMs": true,
	"check":      true,
	"jobId":      true,
	"errorType":  true,
	"stack":      true,
}

const logTimeLayout = "2006-01-02T15:04:05.000Z"

// NewLogger erzeugt einen JSON-Logger mit Allowlist. Zeilen enthalten ts,
// level, message und erlaubte Felder; die Request-ID wird aus dem Context
// ergänzt, wenn mit *Context-Methoden geloggt wird.
func NewLogger(w io.Writer, level slog.Leveler) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level, ReplaceAttr: filterAttr})
	return slog.New(contextHandler{h})
}

func filterAttr(groups []string, a slog.Attr) slog.Attr {
	if len(groups) > 0 {
		return slog.Attr{}
	}
	switch a.Key {
	case slog.TimeKey:
		return slog.String("ts", a.Value.Time().UTC().Format(logTimeLayout))
	case slog.LevelKey:
		if lvl, ok := a.Value.Any().(slog.Level); ok && lvl == slog.LevelWarn {
			return slog.String("level", "WARNING")
		}
		return a
	case slog.MessageKey:
		return slog.String("message", a.Value.String())
	}
	if !allowedLogKeys[a.Key] {
		return slog.Attr{}
	}
	return a
}

type contextHandler struct{ slog.Handler }

func (h contextHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		has := false
		r.Attrs(func(a slog.Attr) bool {
			has = a.Key == "requestId"
			return !has
		})
		if !has {
			r.AddAttrs(slog.String("requestId", id))
		}
	}
	return h.Handler.Handle(ctx, r)
}

func (h contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return contextHandler{h.Handler.WithAttrs(attrs)}
}

func (h contextHandler) WithGroup(name string) slog.Handler {
	return contextHandler{h.Handler.WithGroup(name)}
}
