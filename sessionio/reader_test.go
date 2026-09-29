package sessionio

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeReader answers without touching the filesystem, so a source built on it
// proves the reads really do go through the seam rather than around it.
type fakeReader struct {
	lines  []string
	result string
	asked  []string  // paths it was asked for
	image  ImageAddr // the last picture it was asked for
}

func (f *fakeReader) ReadFrom(path string, off int64) ([]string, int64, error) {
	f.asked = append(f.asked, path)
	if off > 0 {
		return nil, off, nil
	}
	return f.lines, int64(len(f.lines)), nil
}

func (f *fakeReader) FullResult(path, toolID string) (string, json.RawMessage, error) {
	f.asked = append(f.asked, path)
	return f.result, nil, nil
}

func (f *fakeReader) SearchResults(path, q string, limit int) ([]ResultMatch, error) {
	f.asked = append(f.asked, path)
	return nil, nil
}

func (f *fakeReader) ImageBlock(path string, addr ImageAddr) (ImageData, error) {
	f.asked = append(f.asked, path)
	f.image = addr
	return ImageData{MediaType: "image/png", Data: []byte("png bytes")}, nil
}

// The point of the seam: session-events runs as one OS user but serves several,
// and other homes are 0750. A source for another user must read through their
// reader, never through this process's own file access.
func TestFileSourceReadsThroughItsReader(t *testing.T) {
	fr := &fakeReader{
		lines: []string{`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`},
	}
	// A path this process genuinely cannot open — the local path would fail.
	fs := NewFileSourceWith("demo", "/home/someone-else/.claude/projects/x/y.jsonl", time.Millisecond, fr)
	fs.TailOnce()

	got := fs.Replay(0)
	if len(got) != 1 || got[0].Body != "hello" {
		t.Fatalf("expected the reader's line to become an event, got %+v", got)
	}
	if len(fr.asked) == 0 {
		t.Fatal("the reader was never asked — FileSource read around the seam")
	}
}

func TestFileSourceFullResultGoesThroughItsReader(t *testing.T) {
	fr := &fakeReader{result: "the full output"}
	fs := NewFileSourceWith("demo", "/home/someone-else/.claude/projects/x/y.jsonl", time.Millisecond, fr)

	body, _, err := fs.FullResult("tool-1")
	if err != nil {
		t.Fatalf("FullResult: %v", err)
	}
	if body != "the full output" {
		t.Fatalf("expected the reader's answer, got %q", body)
	}
}

// The default stays exactly what it was: a source built the old way reads the
// local filesystem, so every existing caller is unaffected.
func TestNewFileSourceStillReadsLocally(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"local"}]}}`+"\n"), 0o644)

	fs := NewFileSource("demo", p, time.Millisecond)
	fs.TailOnce()
	if got := fs.Replay(0); len(got) != 1 || got[0].Body != "local" {
		t.Fatalf("local read broke: %+v", got)
	}
}

func TestLocalReaderFullResultFindsTheToolResult(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t-9","content":"big output"}]}}`+"\n",
	), 0o644)

	body, _, err := LocalReader{}.FullResult(p, "t-9")
	if err != nil {
		t.Fatalf("FullResult: %v", err)
	}
	if body != "big output" {
		t.Fatalf("got %q", body)
	}
}

// A picture is read back the same way a full result is: through the source's
// reader, so another user's transcript is opened by a child running as them.
func TestFileSourceImageBlockGoesThroughItsReader(t *testing.T) {
	fr := &fakeReader{}
	fs := NewFileSourceWith("demo", "/home/someone-else/.claude/projects/x/y.jsonl", time.Millisecond, fr)

	got, err := fs.ImageBlock(ImageAddr{ToolID: "toolu_01abcdef", N: 2})
	if err != nil {
		t.Fatalf("ImageBlock: %v", err)
	}
	if string(got.Data) != "png bytes" || fr.image.ToolID != "toolu_01abcdef" || fr.image.N != 2 {
		t.Fatalf("got %+v, reader asked for %+v", got, fr.image)
	}
	if len(fr.asked) != 1 || fr.asked[0] != "/home/someone-else/.claude/projects/x/y.jsonl" {
		t.Fatalf("the reader was asked for %v", fr.asked)
	}
}

// scanOf runs ScanImageBlock over transcript lines held in memory.
func scanOf(addr ImageAddr, lines ...string) (ImageData, error) {
	return ScanImageBlock(strings.NewReader(strings.Join(lines, "\n")+"\n"), addr)
}

func TestScanImageBlockFromAToolResult(t *testing.T) {
	pic := testPNG(t, 6)
	got, err := scanOf(ImageAddr{ToolID: "toolu_01read", N: 0},
		// The tool_use line names the id too, and must not be mistaken for it.
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01read","name":"Read","input":{"file_path":"/tmp/a.png"}}]}}`,
		readResultLine("toolu_01read", pic),
	)
	if err != nil {
		t.Fatalf("ScanImageBlock: %v", err)
	}
	if !bytes.Equal(got.Data, pic) || got.MediaType != "image/png" {
		t.Fatalf("got %d bytes of %q, want the %d-byte PNG", len(got.Data), got.MediaType, len(pic))
	}
}

func TestScanImageBlockFromAUserRecord(t *testing.T) {
	a, b := testPNG(t, 3), testPNG(t, 5)
	uuid := "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169"
	got, err := scanOf(ImageAddr{Record: uuid, N: 1},
		pasteLine(uuid, "[Image #1] [Image #2]", `,"imagePasteIds":[1,2]`, imageBlock("image/png", a), imageBlock("image/jpeg", b)))
	if err != nil {
		t.Fatalf("ScanImageBlock: %v", err)
	}
	if !bytes.Equal(got.Data, b) || got.MediaType != "image/jpeg" {
		t.Fatalf("block 1 came back as %d bytes of %q", len(got.Data), got.MediaType)
	}
}

// A message with a picture that Claude took into the turn it was running has
// no user record: its account is a queued_command attachment whose prompt
// holds the blocks (CLI 2.1.284, 2026-09-29). Its picture is read from there.
func TestScanImageBlockFromAnAbsorbedPrompt(t *testing.T) {
	pic := testPNG(t, 4)
	uuid := "021f44fa-fd19-4b58-ba20-b25d1cfcfebe"
	line := `{"parentUuid":"e719f4b6-b4a8-4096-a1f9-bb8a63e427cc","isSidechain":false,` +
		`"attachment":{"type":"queued_command","prompt":[{"type":"text","text":"[Image #1]  pic in queue"},` +
		imageBlock("image/png", pic) + `],"imagePasteIds":[1],"commandMode":"prompt","origin":{"kind":"human"}},` +
		`"type":"attachment","uuid":"` + uuid + `","timestamp":"2026-09-29T07:37:30.298Z"}`
	got, err := scanOf(ImageAddr{Record: uuid, N: 0}, line)
	if err != nil {
		t.Fatalf("ScanImageBlock: %v", err)
	}
	if !bytes.Equal(got.Data, pic) || got.MediaType != "image/png" {
		t.Fatalf("got %d bytes of %q, want the %d-byte PNG", len(got.Data), got.MediaType, len(pic))
	}
}

func TestScanImageBlockOutOfRangeIsNoImage(t *testing.T) {
	_, err := scanOf(ImageAddr{ToolID: "toolu_01read", N: 1}, readResultLine("toolu_01read", testPNG(t, 2)))
	if !errors.Is(err, ErrNoImage) {
		t.Fatalf("err = %v, want ErrNoImage", err)
	}
	_, err = scanOf(ImageAddr{ToolID: "toolu_01gone", N: 0}, readResultLine("toolu_01read", testPNG(t, 2)))
	if !errors.Is(err, ErrNoImage) {
		t.Fatalf("a result that is not there: err = %v, want ErrNoImage", err)
	}
}

// N counts the url block, and the url block has no bytes to serve.
func TestScanImageBlockRefusesANonBase64Source(t *testing.T) {
	line := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01url","content":[` +
		`{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}},` + imageBlock("image/png", testPNG(t, 2)) + `]}]}}`
	if _, err := scanOf(ImageAddr{ToolID: "toolu_01url", N: 0}, line); !errors.Is(err, ErrNoImage) {
		t.Fatalf("err = %v, want ErrNoImage for a url source", err)
	}
	if got, err := scanOf(ImageAddr{ToolID: "toolu_01url", N: 1}, line); err != nil || len(got.Data) == 0 {
		t.Fatalf("block 1 is base64 and must be served: %v", err)
	}
}

// The next record names this one as its parent. Only the record whose own uuid
// it is may answer.
func TestScanImageBlockIgnoresAParentUUID(t *testing.T) {
	uuid := "2ecbc9e7-ef70-4213-bd81-82c2dfcb5169"
	child := `{"type":"user","uuid":"3ecbc9e7-ef70-4213-bd81-82c2dfcb5169","parentUuid":"` + uuid +
		`","message":{"role":"user","content":[{"type":"text","text":"[Image #1]"},` + imageBlock("image/png", testPNG(t, 2)) + `]}}`
	if _, err := scanOf(ImageAddr{Record: uuid, N: 0}, child); !errors.Is(err, ErrNoImage) {
		t.Fatalf("err = %v, want ErrNoImage: the uuid appears only as a parent", err)
	}
}

// The structured copy repeats the picture, and "Show full output" must not
// fetch it: a Read of an image has no text to show in full.
func TestScanToolResultDropsTheStructuredCopyOfAnImage(t *testing.T) {
	body, result, err := ScanToolResult(strings.NewReader(readResultLine("toolu_01read", testPNG(t, 4))+"\n"), "toolu_01read")
	if err != nil {
		t.Fatalf("ScanToolResult: %v", err)
	}
	if body != "" || result != nil {
		t.Fatalf("got body %q and result %s, want nothing", truncate(body, 60), truncate(string(result), 60))
	}
}
