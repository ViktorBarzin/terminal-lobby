package main

// Carrying the resolved identity from the auth wrapper to the handler.
//
// A context value rather than a handler parameter, because the wrapper is an
// http.Handler around a whole mux: it cannot change the signature of what it
// wraps, and re-resolving in each handler would read the credentials file
// twice per request and let the two answers differ.

import (
	"context"
	"log"

	"terminal-lobby/authuser"
)

type identityKey struct{}

// withIdentity attaches the resolved identity to a request's context.
func withIdentity(ctx context.Context, id authuser.Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, id)
}

// identityFrom reads it back. ok=false can only happen for a handler reached
// without the wrapper, which Routes makes impossible — the zero Identity then
// has an empty OSUser, and every handler refuses on that rather than acting as
// nobody.
func identityFrom(ctx context.Context) (authuser.Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(authuser.Identity)
	return id, ok
}

// logf is the service's log line. A var so a test can silence a deliberately
// broken sink without the output drowning the failure it is checking.
var logf = log.Printf
