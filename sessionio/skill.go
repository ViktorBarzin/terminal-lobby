package sessionio

import (
	"path"
	"strings"
)

// Loading a skill injects its WHOLE SKILL.md into the transcript, as a user
// record marked isMeta — text the operator never typed and is not meant to
// read. Left alone it renders as an enormous assistant message in the middle of
// the conversation: measured across this box's transcripts, 312 of them, median
// 3,125 characters and up to 23,342 (Viktor, 2026-08-18).
//
// The load itself is worth one line — a model-invoked skill otherwise changes
// how Claude behaves with nothing in the transcript to say why — so the body is
// replaced by the skill's NAME rather than dropped outright.
const skillMarker = "Base directory for this skill:"

// skillLoad returns the name of the skill this record is loading, and whether
// it is one at all.
//
// The name comes from the directory, which is what the CLI invokes it by. A
// plugin's skill is namespaced the way the CLI spells it — `superpowers:
// brainstorming` lives at …/plugins/cache/<market>/superpowers/<version>/
// skills/brainstorming.
func skillLoad(text string) (string, bool) {
	i := strings.Index(text, skillMarker)
	if i < 0 {
		return "", false
	}
	line := text[i+len(skillMarker):]
	if nl := strings.IndexByte(line, '\n'); nl >= 0 {
		line = line[:nl]
	}
	dir := strings.TrimSpace(line)
	if dir == "" {
		return "", false
	}
	name := path.Base(dir)
	if name == "." || name == "/" {
		return "", false
	}
	// …/<plugin>/<version>/skills/<name> — carry the plugin, drop the version.
	if rest := path.Dir(dir); path.Base(rest) == "skills" {
		if up := path.Dir(rest); up != "." {
			if plugin := path.Base(path.Dir(up)); plugin != "." && plugin != "/" &&
				strings.Contains(up, "/plugins/") {
				return plugin + ":" + name, true
			}
		}
	}
	return name, true
}

// blockText is every text block in a record, joined — a record can split its
// text across several and the marker is only in the first.
func blockText(blocks []Block) string {
	var b strings.Builder
	for _, bl := range blocks {
		if bl.Type == "text" {
			b.WriteString(bl.Text)
			b.WriteByte('\n')
		}
	}
	return b.String()
}
