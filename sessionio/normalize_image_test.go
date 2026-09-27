package sessionio

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

// Pictures in a transcript, 2026-09-24. Viktor: "in text mode i would want to
// be able to view images natively ... agent communicating back with images
// should also render the same way." The shapes below are the ones measured over
// 143 transcripts on this box: a terminal paste is a user record carrying
// [text "[Image #1]", image{base64}] and imagePasteIds [1]; a Read of an image
// is a tool_result whose content is [image{base64}] with a second copy of the
// bytes in toolUseResult.file.base64; a Playwright screenshot is a text result
// linking the file it wrote relative to Claude's launch directory.

// testPNG is a real PNG, so a test that sniffs the bytes sees what a browser
// would. size makes it bigger than the wire cap when a test needs that.
func testPNG(t *testing.T, size int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	// Noise, so the encoder cannot compress a large picture down to nothing.
	seed := uint32(7)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			seed = seed*1664525 + 1013904223
			img.Set(x, y, color.NRGBA{uint8(seed >> 24), uint8(seed >> 16), uint8(seed >> 8), 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func b64(p []byte) string { return base64.StdEncoding.EncodeToString(p) }

// imageBlock is one base64 image content block as Claude Code writes it.
func imageBlock(media string, p []byte) string {
	return `{"type":"image","source":{"type":"base64","media_type":"` + media + `","data":"` + b64(p) + `"}}`
}

// pasteLine is a terminal paste: the placeholder text, then the picture.
func pasteLine(uuid, text string, pasteIDs string, blocks ...string) string {
	content := `{"type":"text","text":` + jsonString(text) + `}`
	for _, b := range blocks {
		content += "," + b
	}
	return `{"type":"user","uuid":"` + uuid + `","parentUuid":"p-0","cwd":"/home/u/proj",` +
		`"message":{"role":"user","content":[` + content + `]}` +
		pasteIDs + `,"timestamp":"2026-09-24T04:01:01.949Z"}`
}

// readResultLine is a Read of an image: an image-only tool_result, and the
// harness's own copy of the same bytes beside it.
func readResultLine(toolID string, p []byte) string {
	return `{"type":"user","uuid":"r-1","message":{"role":"user","content":[{"tool_use_id":"` + toolID +
		`","type":"tool_result","content":[` + imageBlock("image/png", p) + `]}]},` +
		`"toolUseResult":{"type":"image","file":{"base64":"` + b64(p) + `","type":"image/png",` +
		`"originalSize":` + itoa(len(p)) + `,"dimensions":{"originalWidth":64,"originalHeight":64}}}}`
}

// noBase64 fails when any stretch of the picture's base64 reached the wire.
// A 64-character window is enough to be unmistakable and short enough to
// catch a partial copy, such as one cut at the 8 KiB cap.
func noBase64(t *testing.T, e Event, p []byte) {
	t.Helper()
	enc := b64(p)
	if len(enc) > 64 {
		enc = enc[len(enc)/2 : len(enc)/2+64]
	}
	if strings.Contains(string(e.JSON()), enc) {
		t.Fatalf("the picture's base64 reached the wire: %s", truncate(string(e.JSON()), 300))
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func onlyKind(t *testing.T, evs []Event, k Kind) Event {
	t.Helper()
	var got []Event
	for _, e := range evs {
		if e.Kind == k {
			got = append(got, e)
		}
	}
	if len(got) != 1 {
		t.Fatalf("want exactly one %s event, got %d in %v", k, len(got), kinds(evs))
	}
	return got[0]
}

func TestNormalizePastedImageTravelsAsAReference(t *testing.T) {
	pic := testPNG(t, 8)
	n := NewNormalizer("demo")
	out := n.Line([]byte(pasteLine("1ecbc9e7-ef70-4213-bd81-82c2dfcb5169",
		"[Image #1]\n\nwhat is this", `,"imagePasteIds":[1]`, imageBlock("image/png", pic))))

	e := onlyKind(t, out, KindUser)
	if e.Body != "[Image #1]\n\nwhat is this" {
		t.Fatalf("the prompt's text must stay exactly as typed, got %q", e.Body)
	}
	want := []ImageRef{{N: 0, MediaType: "image/png", Bytes: int64(len(pic)), Paste: 1}}
	if !sameRefs(e.Images, want) {
		t.Fatalf("images = %+v, want %+v", e.Images, want)
	}
	if e.RecordID != "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169" {
		t.Fatalf("record = %q, want the record's own uuid", e.RecordID)
	}
	noBase64(t, e, pic)
}

func sameRefs(a, b []ImageRef) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A paste id is only trusted when the record's list lines up one for one with
// its image blocks. Guessing which block a lone id belongs to would put the
// wrong picture where a placeholder was.
func TestNormalizePasteIDsOnlyWhenTheyLineUp(t *testing.T) {
	a, b := testPNG(t, 4), testPNG(t, 5)
	n := NewNormalizer("demo")
	out := n.Line([]byte(pasteLine("u-2", "[Image #1] and another", `,"imagePasteIds":[1]`,
		imageBlock("image/png", a), imageBlock("image/png", b))))

	e := onlyKind(t, out, KindUser)
	if len(e.Images) != 2 {
		t.Fatalf("want both pictures referenced, got %+v", e.Images)
	}
	for _, r := range e.Images {
		if r.Paste != 0 {
			t.Fatalf("paste ids do not line up with the blocks, so none may be set: %+v", e.Images)
		}
	}
	if e.Images[0].N != 0 || e.Images[1].N != 1 {
		t.Fatalf("indexes = %d, %d, want 0, 1", e.Images[0].N, e.Images[1].N)
	}
}

// A user record that is not a prompt keeps dropping its pictures, as it always
// has: isMeta text is the harness speaking, not the person.
func TestNormalizeMetaUserRecordCarriesNoPictures(t *testing.T) {
	n := NewNormalizer("demo")
	line := `{"type":"user","isMeta":true,"uuid":"m-1","message":{"role":"user","content":[` +
		`{"type":"text","text":"injected"},` + imageBlock("image/png", testPNG(t, 4)) + `]}}`
	for _, e := range n.Line([]byte(line)) {
		if len(e.Images) > 0 || e.RecordID != "" {
			t.Fatalf("a meta record grew picture references: %+v", e)
		}
	}
}

// The Read of an image was the worst row in the view: 8 KiB of base64 JSON in a
// <pre>, and "Show full output" fetched the rest of it.
func TestNormalizeReadImageResultCarriesNoBase64(t *testing.T) {
	pic := testPNG(t, 64)
	if len(b64(pic)) <= MaxInlineResult {
		t.Fatalf("fixture is %d base64 characters; it must exceed the %d-byte cap", len(b64(pic)), MaxInlineResult)
	}
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01EaDF17","name":"Read","input":{"file_path":"/tmp/x.png"}}]}}`))
	e := onlyKind(t, n.Line([]byte(readResultLine("toolu_01EaDF17", pic))), KindToolResult)

	if e.Body != "" {
		t.Fatalf("body = %q, want empty: an image-only result has no text", truncate(e.Body, 80))
	}
	want := []ImageRef{{N: 0, MediaType: "image/png", Bytes: int64(len(pic))}}
	if !sameRefs(e.Images, want) {
		t.Fatalf("images = %+v, want %+v", e.Images, want)
	}
	if len(e.Result) != 0 {
		t.Fatalf("the structured copy repeats the picture and must be dropped, got %s", truncate(string(e.Result), 80))
	}
	if e.Truncated {
		t.Fatal("nothing a reader can fetch was cut, so there is no full output to offer")
	}
	noBase64(t, e, pic)
}

func TestNormalizeTextAndImageResult(t *testing.T) {
	pic := testPNG(t, 4)
	n := NewNormalizer("demo")
	e := onlyKind(t, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_mix",`+
		`"content":[{"type":"text","text":"here it is"},`+imageBlock("image/png", pic)+`]}]}}`)), KindToolResult)
	if e.Body != "here it is" {
		t.Fatalf("body = %q", e.Body)
	}
	if len(e.Images) != 1 || e.Images[0].N != 0 {
		t.Fatalf("images = %+v", e.Images)
	}
	if len(e.Files) != 0 {
		t.Fatalf("files = %v, want none", e.Files)
	}
	noBase64(t, e, pic)
}

// A long text beside a picture is still cut, and still offers the rest.
func TestNormalizeLongTextBesideAPictureIsStillCapped(t *testing.T) {
	// Twice the cap, so the cut text plus its "… truncated" marker is still
	// clearly shorter than what was written.
	long := strings.Repeat("x", 2*MaxInlineResult)
	n := NewNormalizer("demo")
	e := onlyKind(t, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_long",`+
		`"content":[{"type":"text","text":"`+long+`"},`+imageBlock("image/png", testPNG(t, 4))+`]}]}}`)), KindToolResult)
	if !e.Truncated || len(e.Body) >= len(long) || !strings.Contains(e.Body, "truncated") {
		t.Fatalf("a long text must be cut and marked truncated: truncated=%v len=%d", e.Truncated, len(e.Body))
	}
}

// N counts every image block, whatever its source, because the byte route
// counts the same way. A block with no base64 gets no reference of its own.
func TestNormalizeNonBase64BlockKeepsTheIndex(t *testing.T) {
	pic := testPNG(t, 4)
	n := NewNormalizer("demo")
	e := onlyKind(t, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_url",`+
		`"content":[{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}},`+imageBlock("image/jpeg", pic)+`]}]}}`)), KindToolResult)
	want := []ImageRef{{N: 1, MediaType: "image/jpeg", Bytes: int64(len(pic))}}
	if !sameRefs(e.Images, want) {
		t.Fatalf("images = %+v, want %+v", e.Images, want)
	}
}

// screenshotPair is a browser_take_screenshot call and its text result.
func screenshotPair(id, text string) []string {
	return []string{
		`{"type":"assistant","cwd":"/home/u/proj/sub","message":{"role":"assistant","content":[{"type":"tool_use","id":"` + id +
			`","name":"mcp__playwright__browser_take_screenshot","input":{"type":"png"}}]}}`,
		`{"type":"user","cwd":"/home/u/proj/sub","message":{"role":"user","content":[{"tool_use_id":"` + id +
			`","type":"tool_result","content":[{"type":"text","text":` + jsonString(text) + `}]}]}}`,
	}
}

// launched opens a normalizer on a transcript whose first cwd is /home/u/proj,
// the directory Claude Code was started in.
func launched(t *testing.T) *Normalizer {
	t.Helper()
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"user","cwd":"/home/u/proj","uuid":"u-0","message":{"role":"user","content":"take a screenshot"}}`))
	return n
}

func shotResult(t *testing.T, n *Normalizer, id, text string) Event {
	t.Helper()
	var out []Event
	for _, ln := range screenshotPair(id, text) {
		out = append(out, n.Line([]byte(ln))...)
	}
	return onlyKind(t, out, KindToolResult)
}

// Playwright MCP 0.0.76 resolves a relative filename against the MCP client's
// workspace, which is the directory Claude was launched in, and prints the link
// relative to the same directory. In the census that held for 85 screenshots of
// 85, while the record's own cwd differed in 65 of them because Claude had cd'd.
func TestNormalizeScreenshotResolvesAgainstTheLaunchDir(t *testing.T) {
	for _, tc := range []struct{ link, want string }{
		{"./page-top.png", "/home/u/proj/page-top.png"},
		{".playwright-mcp/page-1.png", "/home/u/proj/.playwright-mcp/page-1.png"},
		{"/tmp/claude-1000/abs.png", "/tmp/claude-1000/abs.png"},
		{"../../tmp/x.JPG", "/home/tmp/x.JPG"},
	} {
		n := launched(t)
		text := "### Result\n- [Screenshot of viewport](" + tc.link + ")\n### Ran Playwright code\n```js\n" +
			"// Screenshot viewport and save it as " + tc.link + "\nawait page.screenshot({ path: '" + tc.link + "' });\n```"
		e := shotResult(t, n, "toolu_shot1", text)
		if len(e.Files) != 1 || e.Files[0] != tc.want {
			t.Errorf("link %q: files = %v, want [%s]", tc.link, e.Files, tc.want)
		}
		if e.Body != text {
			t.Errorf("link %q: the result's text must be untouched, got %q", tc.link, e.Body)
		}
	}
}

func TestNormalizeScreenshotErrorHasNoFiles(t *testing.T) {
	n := launched(t)
	e := shotResult(t, n, "toolu_shot2", "### Error\nError: File access denied: /tmp/claude-1000/x/page-top.png is "+
		"outside allowed roots. Allowed roots: /home/wizard/code/.playwright-mcp, /home/wizard/code")
	if len(e.Files) != 0 {
		t.Fatalf("an error names no picture, got %v", e.Files)
	}
}

// Only screenshots: a markdown file Claude reads links images relative to THAT
// file, not to the launch directory, so a general rule would ask for pictures
// that are not there.
func TestNormalizeOnlyScreenshotsGetFiles(t *testing.T) {
	n := launched(t)
	n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_bash","name":"Bash","input":{"command":"cat README.md"}}]}}`))
	e := onlyKind(t, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_bash","content":"see [x](./a.png)"}]}}`)), KindToolResult)
	if len(e.Files) != 0 {
		t.Fatalf("a Bash result grew files: %v", e.Files)
	}
}

// A screenshot taken without a filename carries the picture itself; one
// thumbnail is enough, so the block wins and the link is not resolved.
func TestNormalizeScreenshotWithABlockTakesTheBlock(t *testing.T) {
	n := launched(t)
	lines := screenshotPair("toolu_shot3", "")
	lines[1] = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_shot3","type":"tool_result","content":[` +
		`{"type":"text","text":"### Result\n- [Screenshot of viewport](.playwright-mcp/page-2.png)"},` +
		imageBlock("image/png", testPNG(t, 4)) + `]}]}}`
	var out []Event
	for _, ln := range lines {
		out = append(out, n.Line([]byte(ln))...)
	}
	e := onlyKind(t, out, KindToolResult)
	if len(e.Images) != 1 || len(e.Files) != 0 {
		t.Fatalf("images = %+v files = %v, want one block and no files", e.Images, e.Files)
	}
}

// The same link twice is one file.
func TestNormalizeScreenshotFilesAreDeduplicated(t *testing.T) {
	n := launched(t)
	e := shotResult(t, n, "toolu_shot4", "- [a](./p.png)\n- [b](p.png)")
	if len(e.Files) != 1 || e.Files[0] != "/home/u/proj/p.png" {
		t.Fatalf("files = %v", e.Files)
	}
}

func TestB64Size(t *testing.T) {
	for _, tc := range []struct {
		token string
		want  int64
	}{
		{`""`, 0},
		{`"QQ=="`, 1},
		{`"QUI="`, 2},
		{`"QUJD"`, 3},
		{`"QU\/D"`, 3}, // an escaped slash still decodes to one character
		{`"QUJD="`, 3},
		{`null`, 0},
		{`42`, 0},
	} {
		var s b64Size
		if err := json.Unmarshal([]byte(tc.token), &s); err != nil {
			t.Errorf("%s: %v", tc.token, err)
			continue
		}
		if int64(s) != tc.want {
			t.Errorf("%s: size %d, want %d", tc.token, s, tc.want)
		}
	}
	// The real one from the spec: 186,500 characters with one pad are exactly
	// the originalSize the harness recorded beside them.
	var s b64Size
	tok := `"` + strings.Repeat("A", 186499) + `="`
	if err := json.Unmarshal([]byte(tok), &s); err != nil || s != 139874 {
		t.Fatalf("size = %d (%v), want 139874", s, err)
	}
}

// A content array holding neither text nor pictures keeps today's fallback, so
// a block type nobody has seen yet still shows something.
func TestDecodeToolResultUnknownShapeFallsBack(t *testing.T) {
	raw := json.RawMessage(`[{"type":"document","source":{"type":"text","data":"x"}}]`)
	if got := decodeToolResult(raw); got != string(raw) {
		t.Fatalf("got %q, want the raw JSON", got)
	}
	text, images, pictures := decodeToolContent(json.RawMessage(`[` + imageBlock("image/png", testPNG(t, 2)) + `]`))
	if text != "" || len(images) != 1 || pictures != 1 {
		t.Fatalf("an image-only array is text %q, %d reference(s) and %d picture(s), want \"\", 1 and 1",
			text, len(images), pictures)
	}
	// A url block is a picture with no bytes here: no reference, and still no
	// raw JSON standing in for it.
	text, images, pictures = decodeToolContent(json.RawMessage(`[{"type":"image","source":{"type":"url","url":"https://x/a.png"}}]`))
	if text != "" || len(images) != 0 || pictures != 1 {
		t.Fatalf("a url-only array is text %q, %d reference(s) and %d picture(s)", text, len(images), pictures)
	}
}

// Block.Source is decoded for image blocks, but other block types use the same
// key differently: the API's search_result block names its URL as a string.
// encoding/json fails the WHOLE array on one mistyped field, and Blocks() then
// returns nothing, so one odd block would erase every block of the record.
func TestAStringSourceDoesNotEraseTheRecord(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"user","uuid":"u-9","message":{"role":"user","content":[` +
		`{"type":"text","text":"still here"},` +
		`{"type":"search_result","source":"https://example.com/a","title":"a","content":[]}]}}`))
	e := onlyKind(t, out, KindUser)
	if e.Body != "still here" {
		t.Fatalf("body = %q", e.Body)
	}
	text, _, _ := decodeToolContent(json.RawMessage(`[{"type":"text","text":"result text"},{"type":"search_result","source":"https://x"}]`))
	if text != "result text" {
		t.Fatalf("a tool result with a string source decoded to %q", text)
	}
}

// DecodeRecord drops a line whose fields do not match their types, so a paste
// list in a shape nobody has seen yet must cost the paste numbers and nothing
// more: the prompt and its pictures still arrive.
func TestAnOddPasteListDoesNotDropThePrompt(t *testing.T) {
	for _, ids := range []string{`,"imagePasteIds":"1"`, `,"imagePasteIds":[{"id":1}]`, `,"imagePasteIds":null`} {
		n := NewNormalizer("demo")
		out := n.Line([]byte(pasteLine("u-3", "[Image #1] look", ids, imageBlock("image/png", testPNG(t, 2)))))
		e := onlyKind(t, out, KindUser)
		if len(e.Images) != 1 || e.Images[0].Paste != 0 {
			t.Fatalf("%s: images = %+v, want one picture with no paste id", ids, e.Images)
		}
	}
}

// A path pasted into the terminal is attached as a picture, and Claude Code
// follows the prompt with an isMeta record naming where the file came from,
// "[Image: source: <path>]". The desktop check on 2026-09-26 found it rendered
// as a message from Claude, with the same picture drawn a second time under
// it, right below the bubble that already shows it. The note is the harness's
// bookkeeping, like a skill body, so it leaves no row.
func TestNormalizeImageSourceNoteLeavesNoRow(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(pasteLine("u-3", "[Image #2] what colour?", `,"imagePasteIds":[2]`,
		imageBlock("image/png", testPNG(t, 4)))))
	for _, text := range []string{
		"[Image: source: /tmp/pics/paste.png]",
		"[Image: source: /tmp/a.png]\n[Image: source: /home/u/b b.jpg]",
	} {
		note := `{"type":"user","isMeta":true,"uuid":"m-2","parentUuid":"u-3","message":{"role":"user",` +
			`"content":[{"type":"text","text":` + jsonString(text) + `}]}}`
		if out := n.Line([]byte(note)); len(out) != 0 {
			t.Fatalf("the source note for %q became %v", text, kinds(out))
		}
	}
}

// Only the note itself goes. Meta text that merely mentions one, or a person
// typing the same words, keeps the row it always had.
func TestNormalizeImageSourceLookalikesKeepTheirRows(t *testing.T) {
	n := NewNormalizer("demo")
	meta := `{"type":"user","isMeta":true,"uuid":"m-3","message":{"role":"user","content":[` +
		`{"type":"text","text":"see [Image: source: /tmp/a.png] above"}]}}`
	if out := n.Line([]byte(meta)); len(out) != 1 || out[0].Kind != KindText {
		t.Fatalf("meta text around a source note must keep its row, got %v", kinds(out))
	}
	typed := pasteLine("u-4", "[Image: source: /tmp/a.png]", "")
	onlyKind(t, n.Line([]byte(typed)), KindUser)
}

// itoa is strconv.Itoa for the small counts these tests build names from.
func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
