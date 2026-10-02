// Package clipstore is the write side of the per-(user, session) attachment
// store at /var/lib/clipboard-store/<osUser>/<session>/ (ADR-0005).
//
// Two services write into that tree: clipboard-upload, for what a person
// pastes or drops in the browser, and agent-api, for the images and files a
// Caller sends with a message. The gallery lists by filename prefix, the
// cleaner ages directories out by session name, and the store's modes are an
// ADR decision, so the two writers have to agree on all three. They agree by
// sharing this package rather than by keeping two copies in step.
//
// It holds the naming rules, the content sniffing that decides whether bytes
// are an image, and the one function that puts bytes on disk. Reading the
// store back stays in clipboard-upload, which is the only service that serves
// it.
package clipstore

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DefaultRoot is where the store lives on the devvm. deploy.sh and the infra
// playbook create it owned by the account the lobby services run as.
const DefaultRoot = "/var/lib/clipboard-store"

// Filename prefixes. The gallery lists PastedPrefix and DisplayedPrefix only,
// so anything written under AttachPrefix is chat content that is never drawn
// as a thumbnail.
const (
	PastedPrefix    = "pasted-"
	DisplayedPrefix = "displayed-"
	AttachPrefix    = "file-"
)

// UnsortedSession is the bucket for writes that arrive without a valid session
// name. Nothing ties its contents to a session's lifetime, so the cleaner
// (devvm/clipboard-store-clean) ages it out on a fixed clock instead.
const UnsortedSession = "_unsorted"

// SessionNameRe is the tmux session-name charset, the same one tmux-api and
// the frontend's NAME_RE use. A session directory is only ever named by a
// string that matches it, which is what keeps a separator out of the path.
var SessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// Bucket maps a client-supplied session name onto a store directory: a valid
// name keys its own, anything else (absent, oversize, bad charset) collapses
// to UnsortedSession.
func Bucket(session string) string {
	if SessionNameRe.MatchString(session) {
		return session
	}
	return UnsortedSession
}

// SanitizeName reduces an uploaded filename to a safe basename: directory
// components stripped (both / and \ separators), only [A-Za-z0-9._-] kept
// (others become '_'), leading dots removed so nothing lands hidden, length
// bounded by keeping the tail, where the extension is. Falls back to "file".
func SanitizeName(name string) string {
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

// ImageExt is the extension a stored image gets for its content type. PNG is
// the fallback because the gallery re-sniffs on serve; the extension is only a
// hint for a person reading a directory listing.
func ImageExt(ct string) string {
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

// Stamp is the second-resolution timestamp every stored name carries, so a
// directory listing sorts by arrival.
func Stamp() string { return time.Now().Format("20060102-150405") }

// RandToken is eight hex characters, which is what keeps two writes in the
// same second from choosing the same name.
func RandToken() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// PastedName names a stored image of content type ct.
func PastedName(ct string) string {
	return fmt.Sprintf("%s%s-%s%s", PastedPrefix, Stamp(), RandToken(), ImageExt(ct))
}

// AttachName names a stored document, keeping the sanitized original name at
// the end so a person reading the path knows what it was.
func AttachName(original string) string {
	return fmt.Sprintf("%s%s-%s-%s", AttachPrefix, Stamp(), RandToken(), SanitizeName(original))
}

// SniffLen is how many leading bytes Sniff looks at, which is all
// http.DetectContentType ever reads.
const SniffLen = 512

// Sniff reports what the first SniffLen bytes of an upload actually are, per
// http.DetectContentType, with the ISO-BMFF image brands recognised on top.
//
// No filename-extension fallback, deliberately. The extension is
// client-supplied exactly like a Content-Type header, so honouring it would
// let the same mislabelled bytes back in. The one format that costs is SVG,
// which sniffs as text/xml.
//
// This answers "are these bytes an image", NOT "does this image decode". A
// truncated PNG keeps its magic bytes and passes.
func Sniff(head []byte) string {
	if len(head) > SniffLen {
		head = head[:SniffLen]
	}
	ct := http.DetectContentType(head)
	if strings.HasPrefix(ct, "image/") {
		return ct
	}
	if iso := ISOBMFFImageType(head); iso != "" {
		return iso
	}
	return ct
}

// isoBMFFImageBrands are the ISO base media file brands that mean "this is a
// still image": the AV1 (AVIF) and HEVC/HEIF families. A closed list rather
// than "any ftyp", because the same container carries mp4 video.
var isoBMFFImageBrands = map[string]bool{
	"avif": true, "avis": true, // AV1 still image / image sequence
	"heic": true, "heix": true, "heim": true, "heis": true, // HEVC still
	"hevc": true, "hevx": true, "hevm": true, "hevs": true, // HEVC sequence
	"mif1": true, "msf1": true, // generic HEIF still / sequence
}

// ISOBMFFImageType reports the content type of an ISO base media file whose
// major or compatible brands name a still-image format, or "" for anything
// else. Layout: [4-byte box size]["ftyp"][major brand][minor version][compat
// brands...], all brands four bytes.
//
// It exists because http.DetectContentType predates AVIF/HEIF and returns
// application/octet-stream for both. Measured 2026-08-06: a 24x24 AVIF served
// with that content type still renders in chromium, since browsers decode
// images by content, so refusing it would break a format that works today.
func ISOBMFFImageType(head []byte) string {
	if len(head) < 12 || string(head[4:8]) != "ftyp" {
		return ""
	}
	// The box size bounds the brand list; clamp to what was actually read.
	end := int(binary.BigEndian.Uint32(head[0:4]))
	if end > len(head) || end <= 0 {
		end = len(head)
	}
	brands := []string{string(head[8:12])} // major brand
	for i := 16; i+4 <= end; i += 4 {      // compatible brands
		brands = append(brands, string(head[i:i+4]))
	}
	for _, b := range brands {
		if isoBMFFImageBrands[b] {
			if strings.HasPrefix(b, "avi") {
				return "image/avif"
			}
			return "image/heif"
		}
	}
	return ""
}

// errUnsafeElement is returned for a path element that is not one plain name.
var errUnsafeElement = errors.New("clipstore: not a single safe path element")

// safeElement reports whether s is one path element that cannot climb out of
// the directory it is joined onto or hide in it.
func safeElement(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.HasPrefix(s, ".") &&
		!strings.ContainsAny(s, `/\`) && !strings.ContainsRune(s, 0)
}

// SaveToStore writes src into <root>/<osUser>/<session>/<name>, creating the
// directory as needed, and returns the absolute path.
//
// The session must already be a bucket name (see Bucket); osUser and name are
// refused unless each is a single safe path element. Callers build names with
// PastedName or AttachName, so a refusal here means a bug upstream rather than
// a hostile client, and it fails before anything touches disk.
func SaveToStore(root, osUser, session, name string, src io.Reader) (string, error) {
	if !safeElement(name) {
		return "", fmt.Errorf("%w: name %q", errUnsafeElement, name)
	}
	d, err := OpenStoreDir(root, osUser, session)
	if err != nil {
		return "", err
	}
	defer d.Close()
	return d.Save(name, src)
}

// OpenStoreDir opens <root>/<osUser>/<session>/, creating it as needed, for a
// caller that writes several files and may have to take all of them back.
// The same checks as SaveToStore apply. The caller closes it.
func OpenStoreDir(root, osUser, session string) (*Dir, error) {
	if !safeElement(osUser) || !SessionNameRe.MatchString(session) {
		return nil, fmt.Errorf("%w: user %q, session %q", errUnsafeElement, osUser, session)
	}
	userDir, err := UserDir(root, osUser)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(userDir, session)
	// A link here is one tmux-api's rename cascade left under a session's
	// old name, so paths handed out before the rename still open. The
	// session asking now has taken that name and owns nothing behind it, so
	// it gets a directory of its own rather than writing into the other
	// session's.
	if fi, err := os.Lstat(dir); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(dir); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	// Modes per storeModes: the service account's own store is private, and
	// another account's keeps ADR-0005's 0755 so its sessions can read it.
	private := isPrivate(osUser)
	dirMode, _ := storeModes(private)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return nil, err
	}
	d, err := openDir(dir)
	if err != nil {
		return nil, err
	}
	d.private = private
	return d, nil
}

// selfUser is the name of the account this process runs as, "" when it
// cannot be read. A var so a test can stand in another name.
var selfUser = sync.OnceValue(func() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return u.Username
})

// isPrivate reports whether osUser's store is the service account's own.
func isPrivate(osUser string) bool {
	self := selfUser()
	return self != "" && osUser == self
}

// storeModes are a store directory's and file's modes.
//
// docs/adr/0005-session-image-store.md made the whole tree 0755 with 0644
// files, so show-image keeps working for a user who is not the account the
// services run as: that user's sessions read files the service account
// wrote. That reason holds for every other account's store and still sets
// its modes.
//
// It does not hold for the service account's own store, whose sessions run
// as its owner. That store also holds what a Caller sends (agent-api), which
// is personal documents: payslips and tickets were in it when this was
// measured on 2026-10-02, readable by every account on the devvm. So it is
// 0700 with 0600 files.
func storeModes(private bool) (dir, file os.FileMode) {
	if private {
		return 0o700, 0o600
	}
	return 0o755, 0o644
}

// UserDir returns <root>/<osUser>, creating it as needed with storeModes.
// The service account's own directory is narrowed to 0700 when it is found
// wider, so a store made before 2026-10-02 is closed on its next use.
func UserDir(root, osUser string) (string, error) {
	if !safeElement(osUser) {
		return "", fmt.Errorf("%w: user %q", errUnsafeElement, osUser)
	}
	dir := filepath.Join(root, osUser)
	private := isPrivate(osUser)
	mode, _ := storeModes(private)
	if err := os.MkdirAll(dir, mode); err != nil {
		return "", err
	}
	if private {
		fi, err := os.Lstat(dir)
		if err != nil {
			return "", err
		}
		if !fi.IsDir() {
			return "", fmt.Errorf("clipstore: %s is not a directory", dir)
		}
		if fi.Mode().Perm() != mode {
			if err := os.Chmod(dir, mode); err != nil {
				return "", err
			}
		}
	}
	return dir, nil
}

// SecureOwnStore narrows the service account's own store directory to 0700
// at startup, rather than on its first use after an upgrade.
func SecureOwnStore(root string) error {
	self := selfUser()
	if self == "" {
		return errors.New("clipstore: cannot tell which account this is")
	}
	_, err := UserDir(root, self)
	return err
}

// RemoveSession deletes a session's store directory and every link a rename
// left pointing at it, directly or through another such link. Nothing there
// is not an error.
//
// For agent-api's DELETE /v1/conversations: a Caller deleting a conversation
// is a deliberate end with no restore behind it, so its attachments go with
// it rather than riding the 30-day grace a session that died gets (ADR-0005).
func RemoveSession(root, osUser, session string) error {
	if !safeElement(osUser) || !SessionNameRe.MatchString(session) {
		return fmt.Errorf("%w: user %q, session %q", errUnsafeElement, osUser, session)
	}
	userDir := filepath.Join(root, osUser)
	entries, err := os.ReadDir(userDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	// Links name their target by its bare name (tmux-api's renameImageDir).
	links := map[string]string{}
	for _, e := range entries {
		if e.Type()&os.ModeSymlink == 0 {
			continue
		}
		if target, err := os.Readlink(filepath.Join(userDir, e.Name())); err == nil {
			links[e.Name()] = target
		}
	}
	gone := map[string]bool{session: true}
	for grew := true; grew; {
		grew = false
		for name, target := range links {
			if !gone[name] && gone[target] {
				gone[name], grew = true, true
			}
		}
	}
	var first error
	for name := range gone {
		p := filepath.Join(userDir, name)
		fi, err := os.Lstat(p)
		if os.IsNotExist(err) {
			continue
		}
		if err == nil {
			if fi.Mode()&os.ModeSymlink != 0 {
				err = os.Remove(p)
			} else {
				err = os.RemoveAll(p)
			}
		}
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Save copies src into dir/name and returns the path.
func Save(dir, name string, src io.Reader) (string, error) {
	if !safeElement(name) {
		return "", fmt.Errorf("%w: name %q", errUnsafeElement, name)
	}
	d, err := openDir(dir)
	if err != nil {
		return "", err
	}
	defer d.Close()
	return d.Save(name, src)
}

// Save copies src into the directory as name and returns the path the file
// had when it was created.
//
// The create is exclusive: a name that already exists is refused with an
// error wrapping fs.ErrExist rather than overwritten, because a file in the
// store is something a conversation already points at. The random token in
// every generated name makes that refusal a near-impossibility rather than a
// path callers need to handle.
//
// A copy that fails part way, including one cut short by a size limit the
// caller wrapped around src, removes what it wrote, so a refused upload never
// leaves half a file for the next reader to trip on. The removal is relative
// to the open directory, so it still lands when the directory was renamed
// during the copy.
func (d *Dir) Save(name string, src io.Reader) (string, error) {
	if !safeElement(name) {
		return "", fmt.Errorf("%w: name %q", errUnsafeElement, name)
	}
	f, err := d.create(name)
	if err != nil {
		return "", err
	}
	dest := f.Name()
	if _, err := io.Copy(f, src); err != nil {
		f.Close()
		d.unlink(name)
		return "", err
	}
	if err := f.Close(); err != nil {
		d.unlink(name)
		return "", err
	}
	return dest, nil
}

// Remove deletes a file this directory holds, wherever the directory has
// moved to since it was opened.
func (d *Dir) Remove(name string) error {
	if !safeElement(name) {
		return fmt.Errorf("%w: name %q", errUnsafeElement, name)
	}
	return d.unlink(name)
}
