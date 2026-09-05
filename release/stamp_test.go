package release

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// page writes a file under root and returns its path.
func page(t *testing.T, root, name, body string) string {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const diagCore = "globalThis.tlDiag = (function(){ return {v:1}; })();\n"

// A surface with the placeholder on its own line, which is what the inliner
// requires: the whole line is replaced by the core.
const surfaceHTML = `<!doctype html>
<head><meta name="tl-build" content="__TL_BUILD__"><meta name="tl-asset" content="__TL_ASSET__"></head>
<body>
<script>
__TL_DIAG__
</script>
<p>lobby</p>
</body>
`

func TestInlineReplacesThePlaceholderLineWithTheCore(t *testing.T) {
	root := t.TempDir()
	out, err := Inline(page(t, root, "index.html", surfaceHTML), page(t, root, "diag.js", diagCore))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "__TL_DIAG__") {
		t.Fatal("placeholder survived inlining; diagnostics would be dead")
	}
	if !strings.Contains(string(out), "globalThis.tlDiag") {
		t.Fatal("core not present after inlining")
	}
}

func TestInlineRejectsASurfaceWithNoPlaceholder(t *testing.T) {
	root := t.TempDir()
	_, err := Inline(page(t, root, "index.html", "<html><body>no placeholder</body></html>\n"),
		page(t, root, "diag.js", diagCore))
	if err == nil {
		t.Fatal("expected an error: a surface with no placeholder ships no diagnostics")
	}
}

// ADR-0008: diag.js is inlined into a classic script block, which the HTML
// tokenizer ends at the first `</script`. A literal script tag anywhere in the
// file truncates the page mid-JavaScript.
func TestInlineRejectsALiteralScriptTagInTheCore(t *testing.T) {
	root := t.TempDir()
	for _, bad := range []string{
		"// see <script> for details\n" + diagCore,
		diagCore + "// closing </script> in a comment\n",
		diagCore + "// UPPERCASE </SCRIPT>\n",
	} {
		_, err := Inline(page(t, root, "index.html", surfaceHTML), page(t, root, "diag.js", bad))
		if err == nil {
			t.Fatalf("expected an error for a core containing a literal script tag: %q", bad)
		}
	}
}

// sed's `d` deletes the whole matched line, so a placeholder sharing its line
// with the tags takes them with it and the core ships as inert text — present,
// greppable, never executed.
func TestInlineRejectsACoreThatWouldLandOutsideAScriptBlock(t *testing.T) {
	root := t.TempDir()
	inert := `<!doctype html>
<head><meta name="tl-asset" content="__TL_ASSET__"></head>
<body>
<script>__TL_DIAG__</script>
<p>lobby</p>
</body>
`
	_, err := Inline(page(t, root, "index.html", inert), page(t, root, "diag.js", diagCore))
	if err == nil {
		t.Fatal("expected an error: the core would ship as inert text outside a script block")
	}
}

// ADR-0008's load-bearing property. diag.js is inlined into every surface, so a
// change confined to it must move EVERY surface's asset id — otherwise no open
// tab would ever self-update to a fixed diagnostics build.
func TestACoreOnlyChangeMovesEverySurfacesAssetID(t *testing.T) {
	root := t.TempDir()
	lobby := page(t, root, "index.html", surfaceHTML)
	// A second surface, so the property is asserted over more than one file.
	// This was frontend/term.html until 2026-09-05; the name is now a fixture's
	// and nothing reads it as a live path.
	other := page(t, root, "other.html", strings.Replace(surfaceHTML, "lobby", "other", 1))

	before := map[string]string{}
	for name, p := range map[string]string{"lobby": lobby, "other": other} {
		id, err := AssetID(p, page(t, root, "diag.js", diagCore))
		if err != nil {
			t.Fatal(err)
		}
		before[name] = id
	}

	changed := page(t, filepath.Join(root, "v2"), "diag.js", diagCore+"// a fix\n")
	for name, p := range map[string]string{"lobby": lobby, "other": other} {
		id, err := AssetID(p, changed)
		if err != nil {
			t.Fatal(err)
		}
		if id == before[name] {
			t.Fatalf("%s asset id did not move when diag.js changed; a diagnostics fix would never reach an open tab", name)
		}
	}
}

// ADR-0007's property: a backend-only release must ship an identical id so no
// client updates. 55% of commits in the month before ADR-0007 left the page
// byte-identical.
func TestABackendOnlyChangeMovesNoAssetID(t *testing.T) {
	root := t.TempDir()
	surface := page(t, root, "index.html", surfaceHTML)
	diag := page(t, root, "diag.js", diagCore)

	first, err := AssetID(surface, diag)
	if err != nil {
		t.Fatal(err)
	}
	// A backend release changes neither the surface nor the core.
	second, err := AssetID(surface, diag)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("asset id moved with no frontend change: %s -> %s", first, second)
	}
}

// The id must be a fingerprint of the UNSTAMPED content, or every release would
// look like a change to every client.
func TestTheAssetIDIgnoresTheStampsThemselves(t *testing.T) {
	root := t.TempDir()
	surface := page(t, root, "index.html", surfaceHTML)
	diag := page(t, root, "diag.js", diagCore)

	id, err := AssetID(surface, diag)
	if err != nil {
		t.Fatal(err)
	}
	stamped, err := Stamp(surface, diag, Stamps{Build: "deadbee", Asset: id})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stamped), "__TL_BUILD__") || strings.Contains(string(stamped), "__TL_ASSET__") {
		t.Fatal("a placeholder survived stamping")
	}
	if !strings.Contains(string(stamped), "deadbee") || !strings.Contains(string(stamped), id) {
		t.Fatal("stamps were not substituted")
	}
}

func TestTheAssetIDIsTwelveHexCharacters(t *testing.T) {
	root := t.TempDir()
	id, err := AssetID(page(t, root, "index.html", surfaceHTML), page(t, root, "diag.js", diagCore))
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 12 {
		t.Fatalf("asset id is %d chars, want 12: %q", len(id), id)
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("asset id is not lowercase hex: %q", id)
		}
	}
}
