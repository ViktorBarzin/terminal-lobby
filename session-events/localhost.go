package main

import (
	"net"
	"net/http"
)

// localhostOnly rejects requests whose remote address is not a loopback IP. Used
// to lock the /hooks/* endpoints to on-box callers (the Claude Code hooks).
func localhostOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			http.Error(w, "localhost only", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}
