package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// The picture routes, 2026-09-24: a terminal paste and a Read of an image carry
// their bytes in the transcript, and the text view asks for one picture at a
// time, by position, when it scrolls to it (sessionio.ImageRef).

// fakeImages is the one-method source writeImageBlock reads from, so the
// response rules are tested without a transcript.
type fakeImages struct {
	data  sessionio.ImageData
	err   error
	asked sessionio.ImageAddr
}

func (f *fakeImages) ImageBlock(addr sessionio.ImageAddr) (sessionio.ImageData, error) {
	f.asked = addr
	return f.data, f.err
}

func pngOf(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func serveFake(t *testing.T, f *fakeImages) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	writeImageBlock(rec, httptest.NewRequest("GET", "/result/s/toolu_01abcdefgh/image/0", nil), f,
		sessionio.ImageAddr{ToolID: "toolu_01abcdefgh", N: 0})
	return rec
}

func TestWriteImageBlockServesTheBytesWithTheirHeaders(t *testing.T) {
	pic := pngOf(t)
	// The block says JPEG; the bytes are a PNG. The bytes win.
	rec := serveFake(t, &fakeImages{data: sessionio.ImageData{MediaType: "image/jpeg", Data: pic}})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), pic) {
		t.Fatalf("body is %d bytes, want the %d-byte picture", rec.Body.Len(), len(pic))
	}
	for k, want := range map[string]string{
		"Content-Type":           "image/png",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "private, max-age=31536000, immutable",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestWriteImageBlockSourceErrorIs404(t *testing.T) {
	rec := serveFake(t, &fakeImages{err: sessionio.ErrNoImage})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("an error must not be cached, got Cache-Control %q", got)
	}
	// Any failure to read is the same answer to the browser: no picture here.
	if rec := serveFake(t, &fakeImages{err: errors.New("privreader: bob: broken pipe")}); rec.Code != http.StatusNotFound {
		t.Fatalf("a read failure: status %d, want 404", rec.Code)
	}
}

// A block's declared media_type is the harness's word. An SVG or anything else
// that does not sniff as one of the four raster formats is never served from a
// transcript, whatever it calls itself.
func TestWriteImageBlockRefusesBytesThatAreNotAPicture(t *testing.T) {
	for _, data := range [][]byte{
		[]byte("<html><script>alert(1)</script></html>"),
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
	} {
		rec := serveFake(t, &fakeImages{data: sessionio.ImageData{MediaType: "image/png", Data: data}})
		if rec.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("%q: status %d, want 415", data[:10], rec.Code)
		}
		if strings.Contains(rec.Body.String(), "script") {
			t.Fatal("the refused bytes were echoed back")
		}
	}
}

func TestWriteImageBlockRefusesAnOversizedPicture(t *testing.T) {
	big := append(pngOf(t), make([]byte, maxPictureBytes)...)
	rec := serveFake(t, &fakeImages{data: sessionio.ImageData{MediaType: "image/png", Data: big}})
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413", rec.Code)
	}
}

func TestImageAddrFromValidatesThePath(t *testing.T) {
	mk := func(toolID, record, n string) *http.Request {
		r := httptest.NewRequest("GET", "/result/s/x/image/0", nil)
		r.SetPathValue("session", "s")
		r.SetPathValue("toolId", toolID)
		r.SetPathValue("record", record)
		r.SetPathValue("n", n)
		return r
	}
	for _, tc := range []struct {
		name           string
		toolID, record string
		n              string
		isRecord       bool
	}{
		{"negative n", "toolu_01abcdefgh", "", "-1", false},
		{"n past the cap", "toolu_01abcdefgh", "", "100", false},
		{"n not a number", "toolu_01abcdefgh", "", "x", false},
		{"n with a sign", "toolu_01abcdefgh", "", "+1", false},
		{"short tool id", "toolu_1", "", "0", false},
		{"tool id with a slash", "toolu_01abc/../x", "", "0", false},
		{"malformed uuid", "", "1ecbc9e7-ef70-4213-bd81", "0", true},
		{"uuid with junk", "", "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169x", "0", true},
	} {
		if _, err := imageAddrFrom(mk(tc.toolID, tc.record, tc.n), tc.isRecord); err == nil {
			t.Errorf("%s: accepted", tc.name)
		}
	}

	got, err := imageAddrFrom(mk("toolu_01EaDF17CdmXP8Wc3ctiXaL2", "", "3"), false)
	if err != nil || got.ToolID != "toolu_01EaDF17CdmXP8Wc3ctiXaL2" || got.N != 3 || got.Record != "" {
		t.Fatalf("a real tool id: %+v, %v", got, err)
	}
	got, err = imageAddrFrom(mk("", "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169", "0"), true)
	if err != nil || got.Record != "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169" || got.ToolID != "" {
		t.Fatalf("a real record uuid: %+v, %v", got, err)
	}
}

// The whole route, from the registry down to the transcript on disk: the one a
// phone hits when a pasted picture scrolls into view, and the one a Read's
// thumbnail asks for.
func TestServeImageBlockReadsThePictureOutOfTheTranscript(t *testing.T) {
	const user = "someone"
	home := t.TempDir()
	path := writeTranscript(t, home, user, "/w/pics", "picsid", "first")
	pic := pngOf(t)
	enc := base64.StdEncoding.EncodeToString(pic)
	uuid := "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169"
	lines := `{"type":"user","uuid":"` + uuid + `","message":{"role":"user","content":[{"type":"text","text":"[Image #1]"},` +
		`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + enc + `"}}]},"imagePasteIds":[1]}` + "\n" +
		`{"type":"user","uuid":"r-1","message":{"role":"user","content":[{"tool_use_id":"toolu_01readabcd","type":"tool_result",` +
		`"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + enc + `"}}]}]}}` + "\n"
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(lines); err != nil {
		t.Fatal(err)
	}
	f.Close()

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rg := newRegistry(ctx, time.Hour, home, siotest.NewFakeOptions(user+"/pics"), user)
	register(t, rg, user, "picsid", "/w/pics", "pics")

	get := func(target string, record bool, vals map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", target, nil)
		for k, v := range vals {
			r.SetPathValue(k, v)
		}
		r = r.WithContext(context.WithValue(r.Context(), osUserKey, user))
		rec := httptest.NewRecorder()
		serveImageBlock(rec, r, rg, record)
		return rec
	}

	rec := get("/result/pics/user/"+uuid+"/image/0", true, map[string]string{"session": "pics", "record": uuid, "n": "0"})
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), pic) {
		t.Fatalf("the pasted picture: status %d, %d bytes", rec.Code, rec.Body.Len())
	}
	rec = get("/result/pics/toolu_01readabcd/image/0", false, map[string]string{"session": "pics", "toolId": "toolu_01readabcd", "n": "0"})
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), pic) {
		t.Fatalf("the Read's picture: status %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if rec := get("/result/pics/toolu_01readabcd/image/1", false, map[string]string{"session": "pics", "toolId": "toolu_01readabcd", "n": "1"}); rec.Code != http.StatusNotFound {
		t.Fatalf("a block that is not there: status %d, want 404", rec.Code)
	}
	if rec := get("/result/nope/toolu_01readabcd/image/0", false, map[string]string{"session": "nope", "toolId": "toolu_01readabcd", "n": "0"}); rec.Code != http.StatusNotFound {
		t.Fatalf("an unregistered session: status %d, want 404", rec.Code)
	}
	if rec := get("/result/pics/toolu_01readabcd/image/x", false, map[string]string{"session": "pics", "toolId": "toolu_01readabcd", "n": "x"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("a bad index: status %d, want 400", rec.Code)
	}
}

// The events that name those pictures never carry the bytes themselves.
func TestImageEventsCarryNoBase64(t *testing.T) {
	pic := pngOf(t)
	enc := base64.StdEncoding.EncodeToString(pic)
	p := filepath.Join(t.TempDir(), "s.jsonl")
	line := `{"type":"user","uuid":"1ecbc9e7-ef70-4213-bd81-82c2dfcb5169","message":{"role":"user","content":[` +
		`{"type":"text","text":"[Image #1]"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + enc + `"}}]},` +
		`"imagePasteIds":[1]}` + "\n"
	if err := os.WriteFile(p, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	fs := sessionio.NewFileSource("s", p, time.Hour)
	fs.TailOnce()
	for _, e := range fs.Replay(0) {
		if strings.Contains(string(e.JSON()), enc[:32]) {
			t.Fatalf("an event carried the picture's base64: %s", e.JSON())
		}
	}
}
