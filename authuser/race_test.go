package authuser

import (
	"net/http/httptest"
	"sync"
	"testing"
)

// One Gate is shared by every HTTP handler goroutine, and single-user is the hot
// path: it is the default for a fresh install and the only mode the container
// runs. Gate.self() used to memoise into the struct from here, which raced.
// Run with -race; without it this passes either way.
func TestResolveIsSafeUnderConcurrency(t *testing.T) {
	g := &Gate{Config: Config{MultiUser: "off"}, LookupUser: func(string) error { return nil }}
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/whoami", nil)
			r.Header.Set(DefaultAuthHeader, "anyone")
			if _, err := g.Resolve(r); err != nil {
				t.Errorf("resolve: %v", err)
			}
		}()
	}
	wg.Wait()
}
