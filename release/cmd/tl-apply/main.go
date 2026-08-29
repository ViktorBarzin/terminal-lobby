// tl-apply is what the package's maintainer scripts call. It holds no decisions
// of its own: the release package decides, this runs the commands.
//
//	tl-apply snapshot   (preinst)  record what is installed, before dpkg unpacks
//	tl-apply apply      (postinst) restart what changed, verify, keep or revert
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"terminal-lobby/release"
)

// snapshotPath is where preinst leaves what it saw for postinst to compare
// against. Under /run so a reboot mid-upgrade cannot leave a stale one behind.
const snapshotPath = "/run/terminal-lobby-preinst.json"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: tl-apply snapshot|apply")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "snapshot":
		os.Exit(snapshot())
	case "apply":
		os.Exit(apply())
	default:
		fmt.Fprintf(os.Stderr, "tl-apply: unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

func watchedPaths() []string {
	seen := map[string]bool{}
	var out []string
	for _, u := range release.Package.Units {
		for _, f := range u.Files {
			if !seen[f] {
				seen[f] = true
				out = append(out, f)
			}
		}
	}
	return out
}

func snapshot() int {
	before, err := release.Snapshot("/", watchedPaths())
	if err != nil {
		fmt.Fprintln(os.Stderr, "tl-apply: snapshot:", err)
		return 1
	}
	b, err := json.Marshal(before)
	if err != nil {
		fmt.Fprintln(os.Stderr, "tl-apply: snapshot:", err)
		return 1
	}
	if err := os.WriteFile(snapshotPath, b, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "tl-apply: snapshot:", err)
		return 1
	}
	return 0
}

func apply() int {
	before := map[string]string{}
	if b, err := os.ReadFile(snapshotPath); err == nil {
		if err := json.Unmarshal(b, &before); err != nil {
			// A snapshot we cannot read means we cannot tell what moved.
			// Restarting everything is the safe reading, not restarting nothing.
			fmt.Fprintln(os.Stderr, "tl-apply: unreadable snapshot; treating every unit as changed")
			before = map[string]string{}
		}
	}
	defer os.Remove(snapshotPath)

	changed, err := release.ChangedSince("/", before, watchedPaths())
	if err != nil {
		fmt.Fprintln(os.Stderr, "tl-apply:", err)
		return 1
	}
	if len(changed) == 0 {
		fmt.Println("tl-apply: nothing changed; no restarts")
		return 0
	}
	fmt.Printf("tl-apply: %d file(s) changed\n", len(changed))

	targets := release.RestartTargets(release.Package.Units, changed, enabledInstances())
	for _, t := range targets {
		fmt.Println("tl-apply: restarting", t)
		if out, err := exec.Command("systemctl", "restart", t).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "tl-apply: restart %s: %v: %s\n", t, err, out)
		}
	}

	probes := verify()
	writeMetrics(probes)
	if release.Decide(probes) == release.Keep {
		fmt.Println("tl-apply: verified")
		return 0
	}
	for _, p := range probes {
		if !p.OK {
			fmt.Fprintln(os.Stderr, "tl-apply: FAILED:", p.Name)
		}
	}
	// The emergency brake. Not the normal way back: with no version pin the box
	// tracks latest, so a downgrade only holds until the hold is lifted, and the
	// real fix is a higher version carrying the working code.
	return revertAndHold()
}

// verify gives restarted services a moment to bind before probing. A service
// that has not finished starting is not the same as a broken one.
func verify() []release.Probe {
	client := &http.Client{Timeout: 5 * time.Second}
	probes := make([]release.Probe, 0, len(release.Package.Checks))
	for _, c := range release.Package.Checks {
		ok := false
		for attempt := 0; attempt < 10; attempt++ {
			resp, err := client.Get(c.URL)
			if err == nil {
				got := resp.StatusCode
				resp.Body.Close()
				if got == c.WantStatus {
					ok = true
					break
				}
			}
			time.Sleep(time.Second)
		}
		probes = append(probes, release.Probe{Name: c.Name, OK: ok})
	}
	return probes
}

// revertAndHold puts the previous package back from apt's cache and marks it
// held, so the next trigger cannot immediately reinstall what just failed.
func revertAndHold() int {
	prev, err := previousVersion()
	if err != nil || prev == "" {
		fmt.Fprintln(os.Stderr, "tl-apply: verification failed and no previous version is cached; the box stays on this version")
		return 1
	}
	fmt.Fprintln(os.Stderr, "tl-apply: verification failed; reverting to", prev)
	cmd := exec.Command("apt-get", "install", "-y", "--allow-downgrades", "terminal-lobby="+prev)
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive", "TL_SKIP_VERIFY=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "tl-apply: revert failed: %v: %s\n", err, out)
		return 1
	}
	if out, err := exec.Command("apt-mark", "hold", "terminal-lobby").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "tl-apply: hold failed: %v: %s\n", err, out)
	}
	return 1
}

// previousVersion is the newest cached version that is not the one installed —
// apt keeps the .deb it replaced in its archive cache.
func previousVersion() (string, error) {
	out, err := exec.Command("apt-cache", "policy", "terminal-lobby").Output()
	if err != nil {
		return "", err
	}
	var installed string
	var candidates []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "Installed: "); ok {
			installed = v
			continue
		}
		if strings.HasPrefix(line, "***") || strings.HasPrefix(line, "5") || strings.HasPrefix(line, "1") {
			f := strings.Fields(strings.TrimPrefix(line, "***"))
			if len(f) > 0 {
				candidates = append(candidates, f[0])
			}
		}
	}
	for _, c := range candidates {
		if c != installed && c != "(none)" {
			return c, nil
		}
	}
	return "", nil
}

// writeMetrics exports the outcome where Prometheus already scrapes this box,
// so a failed verify or a held package is visible without anyone looking.
func writeMetrics(probes []release.Probe) {
	const dir = "/var/lib/node_exporter/textfile_collector"
	failed := 0
	for _, p := range probes {
		if !p.OK {
			failed++
		}
	}
	held := 0
	if out, err := exec.Command("apt-mark", "showhold").Output(); err == nil &&
		strings.Contains(string(out), "terminal-lobby") {
		held = 1
	}
	body := fmt.Sprintf(
		"# HELP terminal_lobby_verify_failed_probes Probes that failed after the last install.\n"+
			"# TYPE terminal_lobby_verify_failed_probes gauge\nterminal_lobby_verify_failed_probes %d\n"+
			"# HELP terminal_lobby_package_held 1 when the package is held after a failed verify.\n"+
			"# TYPE terminal_lobby_package_held gauge\nterminal_lobby_package_held %d\n"+
			"# HELP terminal_lobby_last_apply_seconds Unix time of the last apply.\n"+
			"# TYPE terminal_lobby_last_apply_seconds gauge\nterminal_lobby_last_apply_seconds %d\n",
		failed, held, time.Now().Unix())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	tmp := dir + "/terminal-lobby.prom.tmp"
	if os.WriteFile(tmp, []byte(body), 0o644) == nil {
		os.Rename(tmp, dir+"/terminal-lobby.prom")
	}
}

// enabledInstances lists the live instances of each templated unit. Enabling a
// user is not this program's business: it needs a hand-written env file
// carrying that user's port allocation.
func enabledInstances() map[string][]string {
	out := map[string][]string{}
	for _, u := range release.Package.Units {
		if !u.Template {
			continue
		}
		b, err := exec.Command("systemctl", "list-units", "--type=service",
			"--state=loaded", "--no-legend", "--no-pager", u.Name+"*").Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(line), "*"))
			if len(f) > 0 && strings.HasPrefix(f[0], u.Name) {
				out[u.Name] = append(out[u.Name], strings.TrimSuffix(f[0], ".service"))
			}
		}
	}
	return out
}
