// slugcheck answers "does TranscriptSlug reproduce the directory Claude Code
// actually wrote?" by asking the transcripts themselves.
//
// The previous S2 check inferred an answer from the SHAPE of the directory
// names — it never called TranscriptSlug, so it reported the same verdict
// before and after the bug was fixed. This one takes ground truth: every
// transcript record carries the `cwd` it was written from, so slugging that cwd
// and comparing it with the directory the file is sitting in is a direct test
// of the rule, with no assumption about what the rule is.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"terminal-lobby/sessionio"
)

func main() {
	root := filepath.Join(os.Getenv("HOME"), ".claude", "projects")
	dirs, err := os.ReadDir(root)
	if err != nil {
		fmt.Printf("cannot read %s: %v\n", root, err)
		os.Exit(2)
	}

	var checked, dotted int
	var bad, misfiled []string
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		cwds := recordedCWDs(filepath.Join(root, d.Name()))
		if len(cwds) == 0 {
			continue
		}
		checked++
		// A directory is named after the cwd the session STARTED in, but a
		// transcript can carry others: a resumed or forked conversation records
		// wherever it is running now. So the rule holds for this directory if
		// ANY recorded cwd slugs to its name — requiring all of them would fail
		// on provenance, not on the slug.
		matched := false
		for _, cwd := range cwds {
			if strings.Contains(cwd, ".") {
				dotted++
			}
			if sessionio.TranscriptSlug(cwd) == d.Name() {
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		// A transcript can be filed under a directory its own cwd does not
		// name — copied, moved, or resumed from elsewhere. The tell is that the
		// cwd we computed names ANOTHER directory that really exists: the rule
		// produced a correct answer, for a different session. That is
		// provenance, not drift, so it is reported and not failed.
		note := fmt.Sprintf("  claude wrote : %s\n    recorded cwds: %s\n    we compute   : %s",
			d.Name(), strings.Join(cwds, ", "), sessionio.TranscriptSlug(cwds[0]))
		if _, err := os.Stat(filepath.Join(root, sessionio.TranscriptSlug(cwds[0]))); err == nil {
			misfiled = append(misfiled, note)
			continue
		}
		bad = append(bad, note)
	}
	sort.Strings(bad)
	sort.Strings(misfiled)

	fmt.Printf("transcript directories with a readable cwd: %d (%d of them from a cwd containing a dot)\n", checked, dotted)
	if checked == 0 {
		fmt.Println("nothing to compare against")
		os.Exit(3)
	}
	if len(misfiled) > 0 {
		fmt.Printf("%d directory holds transcripts filed under another session's name (provenance, not the slug rule):\n%s\n",
			len(misfiled), strings.Join(misfiled, "\n"))
	}
	if len(bad) == 0 {
		fmt.Printf("TranscriptSlug reproduces every attributable directory name (%d checked, %d misfiled and skipped)\n",
			checked-len(misfiled), len(misfiled))
		return
	}
	fmt.Printf("%d directories TranscriptSlug does NOT reproduce:\n%s\n", len(bad), strings.Join(bad, "\n"))
	os.Exit(1)
}

// recordedCWDs collects the distinct cwds the transcripts in dir report.
// Records that predate the field, and directories holding none, yield nothing
// rather than a failure: an old transcript proves nothing either way. Reading
// is bounded — the first record of each file is enough, and these files reach
// megabytes.
func recordedCWDs(dir string) []string {
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, f := range files {
		if filepath.Ext(f.Name()) != ".jsonl" {
			continue
		}
		fh, err := os.Open(filepath.Join(dir, f.Name()))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			var rec struct {
				CWD string `json:"cwd"`
			}
			if json.Unmarshal(sc.Bytes(), &rec) == nil && rec.CWD != "" {
				if !seen[rec.CWD] {
					seen[rec.CWD] = true
					out = append(out, rec.CWD)
				}
				break
			}
		}
		fh.Close()
	}
	return out
}
