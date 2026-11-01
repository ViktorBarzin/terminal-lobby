package t3client

import (
	"net/url"
	"strconv"
	"testing"
)

// fixedPort returns a PortLookup naming the port of a test server.
func fixedPort(t *testing.T, base string) PortLookup {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return func(string) (int, error) { return p, nil }
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
