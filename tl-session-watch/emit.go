package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// What the watcher says, and where.
//
// Two outputs, for two jobs. Journal lines are what the alerts are built on:
// the unit sets SyslogIdentifier=tl-session-watch, promtail labels that
// identifier, and the Loki rules select on it. The textfile metric is history —
// node_exporter picks it up on a 2-minute scrape, which is too slow to alert on
// but is what will let us move the pane threshold on evidence rather than guess.

// Line renders one finding as logfmt, which LogQL parses without a regexp.
func Line(f Finding) string {
	fields := []string{
		"event=" + string(f.Kind),
		"user=" + logfmtValue(f.User),
	}
	// A reboot is about the box. An empty session field would read as a session
	// whose name is the empty string.
	if f.Session != "" {
		fields = append(fields, "session="+logfmtValue(f.Session))
	}
	if f.State != "" {
		fields = append(fields, "state="+logfmtValue(f.State))
	}
	if f.PaneLimit > 0 {
		fields = append(fields,
			"pane_bytes="+strconv.FormatUint(f.PaneBytes, 10),
			"pane_unreclaimable="+strconv.FormatUint(f.PaneUnreclaimable, 10),
			"pane_limit="+strconv.FormatUint(f.PaneLimit, 10),
		)
	}
	if f.Kind == KindRebooted {
		fields = append(fields,
			"before="+strconv.Itoa(f.Before),
			"after="+strconv.Itoa(f.After),
		)
	}
	return strings.Join(fields, " ")
}

// Heartbeat is emitted every tick whether or not anything was found. It is what
// SessionWatchSilent waits for, so its absence is the signal that the thing
// preventing silent failures has failed silently.
func Heartbeat(users, sessions int) string {
	return fmt.Sprintf("event=heartbeat users=%d sessions=%d", users, sessions)
}

// logfmtValue quotes a value when it holds anything that would otherwise split
// the record into extra fields.
func logfmtValue(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\"=\\") {
		return s
	}
	return strconv.Quote(s)
}

// --- the exported metric --------------------------------------------------

// renderTextfile writes the Prometheus text format node_exporter's textfile
// collector reads. Sessions come out in name order: map iteration is random, and
// a file whose line order churns every 30 seconds cannot be diffed.
func renderTextfile(snaps []Snapshot) string {
	var b strings.Builder

	// Panes can SHARE a cgroup: measured 2026-09-01, four of emo's claudes sat in
	// one run-r*.scope, so each of those four reported the same 2.09 GB. The value
	// is what this session is exposed to, not this session's own share, and it is
	// therefore not additive across sessions.
	b.WriteString("# HELP tl_pane_memory_bytes Memory in the cgroup this session's largest process sits in. Panes can share a cgroup, so this is not additive across sessions.\n")
	b.WriteString("# TYPE tl_pane_memory_bytes gauge\n")
	each(snaps, func(user string, s Session) {
		fmt.Fprintf(&b, "tl_pane_memory_bytes{user=%s,session=%s} %d\n",
			metricValue(user), metricValue(s.Name), s.PaneBytes)
	})

	// The number the pre-warning actually compares. Kept separate from
	// memory.current because current rides up to the cap in any pane doing file
	// I/O — the cap reclaims cache rather than killing — so only this one says
	// how close a kill is.
	b.WriteString("# HELP tl_pane_unreclaimable_bytes Pane memory that the cap cannot reclaim (anon + shmem), which is what forces a kill.\n")
	b.WriteString("# TYPE tl_pane_unreclaimable_bytes gauge\n")
	each(snaps, func(user string, s Session) {
		fmt.Fprintf(&b, "tl_pane_unreclaimable_bytes{user=%s,session=%s} %d\n",
			metricValue(user), metricValue(s.Name), s.PaneUnreclaimable)
	})

	b.WriteString("# HELP tl_pane_memory_max_bytes The pane cgroup's memory cap, 0 when uncapped.\n")
	b.WriteString("# TYPE tl_pane_memory_max_bytes gauge\n")
	each(snaps, func(user string, s Session) {
		fmt.Fprintf(&b, "tl_pane_memory_max_bytes{user=%s,session=%s} %d\n",
			metricValue(user), metricValue(s.Name), s.PaneLimit)
	})

	// Which side of the cap's ranking this pane is on. The cap picks the
	// highest-RSS task, so this is the difference between it taking a build and
	// it taking a conversation.
	b.WriteString("# HELP tl_pane_top_is_claude 1 when the largest process in the pane is a claude.\n")
	b.WriteString("# TYPE tl_pane_top_is_claude gauge\n")
	each(snaps, func(user string, s Session) {
		v := 0
		if s.TopIsClaude {
			v = 1
		}
		fmt.Fprintf(&b, "tl_pane_top_is_claude{user=%s,session=%s} %d\n",
			metricValue(user), metricValue(s.Name), v)
	})

	return b.String()
}

func each(snaps []Snapshot, fn func(user string, s Session)) {
	users := make([]Snapshot, len(snaps))
	copy(users, snaps)
	sort.Slice(users, func(i, j int) bool { return users[i].User < users[j].User })
	for _, snap := range users {
		names := make([]string, 0, len(snap.Sessions))
		for name := range snap.Sessions {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			fn(snap.User, snap.Sessions[name])
		}
	}
}

// metricValue escapes a label value. An unescaped quote or backslash makes the
// whole file unparseable, which drops every series in it rather than one.
func metricValue(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// WriteTextfile replaces the metric file atomically. node_exporter reads the
// directory on every scrape, so a half-written file would be served as truth.
func WriteTextfile(path string, snaps []Snapshot) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(renderTextfile(snaps)), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
