package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Pin is what the installed package says it was built from: t3-view/T3_PIN,
// shipped beside the sidecar.
type Pin struct {
	Tag string
	// Repo is owner/name on GitHub.
	Repo string
}

// ReadPin reads the tag= and repo= lines of a T3_PIN file. The repo has to be
// on GitHub, because the releases API is where "latest stable" is answered.
func ReadPin(text string) (Pin, error) {
	var p Pin
	var repo string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if v, ok := strings.CutPrefix(line, "tag="); ok && p.Tag == "" {
			p.Tag = strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(line, "repo="); ok && repo == "" {
			repo = strings.TrimSpace(v)
		}
	}
	if p.Tag == "" {
		return Pin{}, errors.New("T3_PIN names no tag=")
	}
	slug, ok := strings.CutPrefix(repo, "https://github.com/")
	if !ok {
		return Pin{}, fmt.Errorf("T3_PIN repo=%q is not a https://github.com/ repository", repo)
	}
	slug = strings.TrimSuffix(strings.TrimSuffix(slug, "/"), ".git")
	if parts := strings.Split(slug, "/"); len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return Pin{}, fmt.Errorf("T3_PIN repo=%q does not name owner/repository", repo)
	}
	p.Repo = slug
	return p, nil
}

// LatestReleaseURL is GitHub's answer to "the newest stable release": it
// leaves out drafts and prereleases.
func (p Pin) LatestReleaseURL() string {
	return "https://api.github.com/repos/" + p.Repo + "/releases/latest"
}

// Release is the part of a GitHub release this check reads.
type Release struct {
	Tag       string
	Published time.Time
}

// ParseRelease reads tag_name and published_at from a releases API answer.
func ParseRelease(body []byte) (Release, error) {
	var raw struct {
		TagName     string `json:"tag_name"`
		PublishedAt string `json:"published_at"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return Release{}, fmt.Errorf("release is not JSON: %w", err)
	}
	if raw.TagName == "" {
		return Release{}, errors.New("release has no tag_name")
	}
	published, err := time.Parse(time.RFC3339, raw.PublishedAt)
	if err != nil {
		return Release{}, fmt.Errorf("release %s published_at %q: %w", raw.TagName, raw.PublishedAt, err)
	}
	return Release{Tag: raw.TagName, Published: published}, nil
}

const metricName = "tl_t3_upstream_unadopted_since_seconds"

const helpText = "Publish time of the latest stable T3 Code release when the installed T3 view is pinned to another tag, 0 when it is the latest."

// Render writes the one-series textfile. The value is the publish time of a
// release the box has not taken, so an alert can say how long it has waited
// (time() - value), and 0 when the pin is the latest.
func Render(latest Release, pinned string) string {
	var value int64
	if latest.Tag != pinned {
		value = latest.Published.Unix()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# HELP %s %s\n", metricName, helpText)
	fmt.Fprintf(&b, "# TYPE %s gauge\n", metricName)
	fmt.Fprintf(&b, "%s{latest=%s,pinned=%s} %d\n", metricName, labelValue(latest.Tag), labelValue(pinned), value)
	return b.String()
}

// labelValue escapes a label value. An unescaped quote or backslash makes
// node_exporter drop the whole file.
func labelValue(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return `"` + r.Replace(s) + `"`
}

// buildID is set at link time by packaging/build-deb.sh.
var buildID = "dev"

// FetchLatest asks the releases API for the latest stable release.
// Unauthenticated: one request a day is well inside the anonymous limit.
func FetchLatest(ctx context.Context, client *http.Client, url string) (Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Release{}, err
	}
	// GitHub refuses API requests that carry no User-Agent.
	req.Header.Set("User-Agent", "terminal-lobby-tl-t3-upstream-check/"+buildID)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return Release{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Release{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return ParseRelease(body)
}

// WriteAtomic replaces path in one rename. node_exporter reads the directory
// on every scrape, so a half-written file would be served as truth.
func WriteAtomic(path, content string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once the rename has happened
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// run reads the installed pin, asks GitHub for the latest stable release and
// writes the metric. Any failure writes nothing: the file keeps its old mtime,
// and the staleness alert on that mtime is what reports a check that has
// stopped working. An empty url means the pin's own repository.
func run(ctx context.Context, client *http.Client, pinPath, url, out string) error {
	text, err := os.ReadFile(pinPath)
	if err != nil {
		return err
	}
	pin, err := ReadPin(string(text))
	if err != nil {
		return fmt.Errorf("%s: %w", pinPath, err)
	}
	if url == "" {
		url = pin.LatestReleaseURL()
	}
	latest, err := FetchLatest(ctx, client, url)
	if err != nil {
		return err
	}
	if err := WriteAtomic(out, Render(latest, pin.Tag)); err != nil {
		return err
	}
	fmt.Printf("latest=%s pinned=%s published=%s held=%t\n",
		latest.Tag, pin.Tag, latest.Published.Format(time.RFC3339), latest.Tag != pin.Tag)
	return nil
}
