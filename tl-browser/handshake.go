package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The handshake cache.
//
// Claude starts every MCP server it is configured with when a session starts,
// and asks each one for its tool list straight away. Answering that from the
// host itself would cost a Node process (141 MB resident, measured 2026-10-01)
// in every session, including the many that never browse. So the launcher
// answers from a file instead: the host's own initialize result and tool list,
// captured once by running the host in describe mode.
//
// The file is keyed by a hash of the host's sources (host.mjs and lib/) and its
// package-lock.json, so a release that changes the host or bumps playwright-mcp
// gets a fresh one rather than an old tool list and instructions.

// Handshake is what `node host.mjs --describe` prints and the cache holds.
type Handshake struct {
	Initialize json.RawMessage `json:"initialize"`
	Tools      json.RawMessage `json:"tools"`
}

func (h *Handshake) valid() bool {
	return len(h.Initialize) > 0 && h.Initialize[0] == '{' &&
		len(h.Tools) > 0 && h.Tools[0] == '{'
}

// HandshakeCache finds the handshake for one host version, describing the host
// when no cached copy exists.
type HandshakeCache struct {
	Dir      string   // usually CacheDir(...)
	Version  string   // HostVersion of the host
	Describe []string // argv that prints the handshake and exits
	Env      []string // environment for Describe
	Timeout  time.Duration
}

// CacheDir is $XDG_CACHE_HOME/tl-browser, or ~/.cache/tl-browser without it.
func CacheDir(xdgCacheHome, home string) string {
	if xdgCacheHome != "" {
		return filepath.Join(xdgCacheHome, "tl-browser")
	}
	return filepath.Join(home, ".cache", "tl-browser")
}

// HostVersion is the first 16 hex digits of a sha256 over every file the host
// loads that can change what it answers: host.mjs, each lib/**/*.mjs and
// package-lock.json. The server instructions and the browser_close note live
// in lib/, so hashing host.mjs alone would serve a stale handshake after a lib
// change. Files go in a fixed order (host.mjs, lib/ sorted by path, then the
// lockfile), each framed by its path and length so content moving between
// files changes the key too. A missing lib/ or lockfile is skipped.
func HostVersion(hostPath string) (string, error) {
	dir := filepath.Dir(hostPath)
	files := []string{filepath.Base(hostPath)}
	var lib []string
	err := filepath.WalkDir(filepath.Join(dir, "lib"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".mjs") {
			rel, err := filepath.Rel(dir, p)
			if err != nil {
				return err
			}
			lib = append(lib, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	sort.Strings(lib)
	files = append(files, lib...)
	files = append(files, "package-lock.json")

	h := sha256.New()
	for i, rel := range files {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if errors.Is(err, fs.ErrNotExist) && i > 0 {
			continue
		}
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s\x00%d\x00", rel, len(b))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

func (c *HandshakeCache) Path() string {
	return filepath.Join(c.Dir, "handshake-"+c.Version+".json")
}

// Load returns the cached handshake, describing the host and writing the cache
// on a miss. A cache file that does not parse is treated as a miss.
func (c *HandshakeCache) Load() (*Handshake, error) {
	if b, err := os.ReadFile(c.Path()); err == nil {
		var hs Handshake
		if json.Unmarshal(b, &hs) == nil && hs.valid() {
			return &hs, nil
		}
	}
	hs, raw, err := c.describe()
	if err != nil {
		return nil, err
	}
	// A failed write costs the next session one more describe, nothing else.
	_ = c.write(raw)
	return hs, nil
}

func (c *HandshakeCache) describe() (*Handshake, []byte, error) {
	if len(c.Describe) == 0 {
		return nil, nil, errors.New("no describe command")
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Describe[0], c.Describe[1:]...)
	cmd.Env = c.Env
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, nil, fmt.Errorf("describe the browser host: %w", err)
	}
	// One JSON object is the contract. Anything a dependency printed before it
	// is skipped by taking the last non-empty line.
	lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
	raw := bytes.TrimSpace(lines[len(lines)-1])
	var hs Handshake
	if err := json.Unmarshal(raw, &hs); err != nil || !hs.valid() {
		return nil, nil, fmt.Errorf("describe the browser host: unexpected output %.200q", out)
	}
	return &hs, raw, nil
}

// write lands the cache atomically, so two sessions starting together never
// read half a file.
func (c *HandshakeCache) write(raw []byte) error {
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(c.Dir, ".handshake-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), c.Path())
}
