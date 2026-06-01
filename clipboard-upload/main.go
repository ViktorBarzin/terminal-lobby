package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	imageDir   = "/tmp/clipboard-images"
	fileDir    = "/tmp/clipboard-files"
	maxUpload  = 100 << 20 // 100MB
	listenAddr = "0.0.0.0:7683"
)

func main() {
	for _, d := range []string{imageDir, fileDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			log.Fatalf("Failed to create upload dir %s: %v", d, err)
		}
	}

	http.HandleFunc("/upload", handleUpload)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Printf("Clipboard upload service listening on %s (images=%s files=%s)", listenAddr, imageDir, fileDir)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}

// handleUpload accepts a multipart POST with EITHER a generic "file" field
// (drag-dropped files of any type, saved under fileDir keeping the original
// name) OR a legacy "image" field (clipboard image paste/upload, must be
// image/*, saved under imageDir with a random name). Responds {"path": "..."}.
func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	// Keep a modest amount in memory; larger parts spill to temp files on disk.
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		http.Error(w, "File too large (max 100MB)", http.StatusRequestEntityTooLarge)
		return
	}

	// Generic dropped file — any content type, keep the (sanitized) original name.
	if file, header, err := r.FormFile("file"); err == nil {
		defer file.Close()
		name := fmt.Sprintf("%s-%s-%s", stamp(), randToken(), sanitizeName(header.Filename))
		path, err := save(fileDir, name, file)
		if err != nil {
			http.Error(w, "Failed to save", http.StatusInternalServerError)
			return
		}
		log.Printf("Saved dropped file: %s (%d bytes)", path, header.Size)
		writePath(w, path)
		return
	}

	// Legacy clipboard image — must be image/*, random name + extension.
	file, header, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "Missing 'file' or 'image' field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	ct := header.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		http.Error(w, "Not an image", http.StatusBadRequest)
		return
	}
	name := fmt.Sprintf("%s-%s%s", stamp(), randToken(), imageExt(ct))
	path, err := save(imageDir, name, file)
	if err != nil {
		http.Error(w, "Failed to save", http.StatusInternalServerError)
		return
	}
	log.Printf("Saved clipboard image: %s (%s, %d bytes)", path, ct, header.Size)
	writePath(w, path)
}

func save(dir, name string, src io.Reader) (string, error) {
	dest := filepath.Join(dir, name)
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, src); err != nil {
		os.Remove(dest)
		return "", err
	}
	return dest, nil
}

// sanitizeName reduces an uploaded filename to a safe basename: directory
// components stripped (handling both / and \ separators), only [A-Za-z0-9._-]
// kept (others -> '_'), leading dots removed (no hidden files), length bounded.
// Falls back to "file".
func sanitizeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			return r
		default:
			return '_'
		}
	}, name)
	name = strings.TrimLeft(name, ".")
	if len(name) > 128 {
		name = name[len(name)-128:]
	}
	if name == "" {
		name = "file"
	}
	return name
}

func imageExt(ct string) string {
	switch ct {
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".png"
	}
}

func stamp() string { return time.Now().Format("20060102-150405") }

func randToken() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writePath(w http.ResponseWriter, path string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": path})
}
