package main

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"terminal-lobby/telemetry"
)

const (
	// maxFileSize caps a single read or write payload. The preview/editor
	// surface (markdown / HTML / code) never legitimately needs more.
	maxFileSize = 10 << 20 // 10MB
	// maxWriteBody bounds the whole /files/write request body. It sits well
	// above maxFileSize so JSON-string escaping of a 10MB text payload still
	// fits; the authoritative cap is the len(content) check after decoding.
	maxWriteBody = 2*maxFileSize + 64<<10
)

// fileEntry is one row of GET /files/list.
type fileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	IsDir bool   `json:"isDir"`
}

// handleList (GET /files/list?dir=<abs>) lists the entries directly under dir,
// within the caller's home, newest-agnostic (dirs first, then names). Dotfiles
// are hidden unless ?all=1.
//
// Dotfile judgment: hiding dot-entries by default is a UX default (the
// preview/editor surfaces recent files and dirs, not a dotfile audit; ls does
// the same), NOT the security boundary — containment-within-home is, and it is
// enforced identically for every entry. Read/write place no special bar on
// dotfiles: this API sits beside a full terminal (ttyd) into the SAME home and
// runs as the SAME OS user, so a dotfile denylist would add no real protection
// (the terminal already exposes everything) while breaking legitimate edits of
// .gitignore / .env / .bashrc. The org rule "impose no restriction stricter
// than the OS" points the same way.
func handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	resolved, err := resolveWithin(userHome(osUser), r.URL.Query().Get("dir"), true)
	if err != nil {
		pathHTTPError(w, err)
		return
	}
	info, err := os.Stat(resolved)
	if err != nil {
		pathHTTPError(w, err) // ENOENT (racy delete) → 404, else 500
		return
	}
	if !info.IsDir() {
		http.Error(w, "not a directory", http.StatusBadRequest)
		return
	}
	dirents, err := os.ReadDir(resolved)
	if err != nil {
		log.Printf("readdir %s: %v", resolved, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	includeAll := r.URL.Query().Get("all") == "1"
	entries := make([]fileEntry, 0, len(dirents))
	for _, d := range dirents {
		name := d.Name()
		if !includeAll && strings.HasPrefix(name, ".") {
			continue
		}
		fi, err := d.Info()
		if err != nil {
			continue // vanished mid-scan
		}
		entries = append(entries, fileEntry{
			Name:  name,
			Path:  filepath.Join(resolved, name),
			Size:  fi.Size(),
			Mtime: fi.ModTime().Unix(),
			IsDir: fi.IsDir(),
		})
	}
	// Directories first, then case-sensitive name order — a stable, predictable
	// layout for a file picker.
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, entries)
}

// handleRead (GET /files/read?path=<abs>) streams a single regular file back
// with a sniffed content-type. Missing → 404; a directory or oversize file →
// 400/413.
func handleRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	resolved, err := resolveWithin(userHome(osUser), r.URL.Query().Get("path"), true)
	if err != nil {
		pathHTTPError(w, err)
		return
	}
	info, err := os.Stat(resolved)
	if err != nil {
		pathHTTPError(w, err)
		return
	}
	if info.IsDir() {
		http.Error(w, "path is a directory", http.StatusBadRequest)
		return
	}
	if !info.Mode().IsRegular() {
		http.Error(w, "not a regular file", http.StatusBadRequest)
		return
	}
	if info.Size() > maxFileSize {
		http.Error(w, "file too large (max 10MB)", http.StatusRequestEntityTooLarge)
		return
	}
	f, err := os.Open(resolved)
	if err != nil {
		pathHTTPError(w, err)
		return
	}
	defer f.Close()

	// Sniff the content-type from the first 512 bytes, then rewind — stored
	// extensions are advisory (mirrors clipboard-upload's /img).
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		log.Printf("read %s: %v", resolved, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		log.Printf("rewind %s: %v", resolved, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// SVG is the one previewable image the sniffer cannot name: it has no
	// binary signature, so DetectContentType calls the source text/plain — and
	// Chrome will not parse an SVG out of an <img> unless the type is exactly
	// image/svg+xml (it content-sniffs raster formats regardless, which is why
	// this is one extension and not a table). The preview routes .svg to the
	// image kind and offers no Raw/Edit fallback there, so the mislabel left
	// SVGs unviewable anywhere in the app.
	ct := http.DetectContentType(head[:n])
	if strings.EqualFold(filepath.Ext(resolved), ".svg") {
		ct = "image/svg+xml"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	// The extension is the useful signal: which KINDS of file get previewed
	// (markdown, code, images) drives what the preview surface should do next.
	events.Emit("file.previewed", osUser, telemetry.Attrs{
		"tl.kind": strings.ToLower(filepath.Ext(resolved)), "tl.client": "api",
	})
	// ServeContent handles Range/If-Modified-Since and won't override the
	// Content-Type we set above.
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// handleWrite (POST /files/write {path, content}) writes content to path within
// the caller's home, creating or overwriting a regular file, and replies 204.
func handleWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWriteBody)
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "file too large (max 10MB)", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if len(body.Content) > maxFileSize {
		http.Error(w, "file too large (max 10MB)", http.StatusRequestEntityTooLarge)
		return
	}
	resolved, err := resolveWithin(userHome(osUser), body.Path, false)
	if err != nil {
		pathHTTPError(w, err)
		return
	}
	// Never overwrite a non-regular target. resolveWithin already unmasked a
	// leaf symlink that escapes home (layer 4); this refuses to clobber a
	// directory or an in-home special file, and refuses to create through a
	// broken symlink.
	if info, err := os.Lstat(resolved); err == nil && !info.Mode().IsRegular() {
		http.Error(w, "target is not a regular file", http.StatusBadRequest)
		return
	}
	if err := os.WriteFile(resolved, []byte(body.Content), 0o644); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "parent directory does not exist", http.StatusNotFound)
			return
		}
		log.Printf("write %s: %v", resolved, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	events.Emit("file.saved", osUser, telemetry.Attrs{
		"tl.kind":  strings.ToLower(filepath.Ext(resolved)),
		"tl.count": len(body.Content), "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}

// pathHTTPError maps a resolveWithin/os error to a status code. ENOENT is a
// clean 404; the two containment sentinels are 400; everything else (a home
// that won't resolve, a permission error) is an opaque 500. The message never
// echoes the path, so a probe can't distinguish "outside home" from "does not
// exist" for out-of-home targets.
func pathHTTPError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotAbsolute):
		http.Error(w, "path must be absolute", http.StatusBadRequest)
	case errors.Is(err, errOutsideHome):
		http.Error(w, "invalid path", http.StatusBadRequest)
	case errors.Is(err, fs.ErrNotExist):
		http.Error(w, "not found", http.StatusNotFound)
	default:
		log.Printf("path resolution error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	http.Error(w, allowed+" only", http.StatusMethodNotAllowed)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode json: %v", err)
	}
}
