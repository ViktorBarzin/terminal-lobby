package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/user"
	"strconv"
	"strings"
)

// Who is really calling a hook.
//
// The SessionStart hook says which OS user it is for, and that string used to be
// the whole of the answer: registry.user() creates state keyed on it, and
// sessionio reaches `sudo -n -u <that name> tmux set-option`. localhostOnly
// authenticates the HOST, not the account, and every lobby user has a shell
// here, so any of them could name any other. Peer credentials replace the claim
// with something the caller cannot choose.
//
// Linux has no SO_PEERCRED for TCP, so the uid comes from the kernel's own
// socket tables: the client's socket appears in /proc/net/tcp{,6} with its
// local_address equal to our RemoteAddr, and the uid column is the account that
// opened it. A unix socket would be the sturdier answer and would also cost the
// hook script a rewrite; this reads the same fact the kernel would report there.

// hookBodyLimit bounds a hook payload. The middleware has to read the body to
// see the claim before the handler decodes it, so the read needs a ceiling.
const hookBodyLimit = 64 << 10

// procNetTCP names the socket tables. A var so the tests can point it at a
// fixture rather than at the live kernel.
var procNetTCP = []string{"/proc/net/tcp", "/proc/net/tcp6"}

var errNoPeerSocket = errors.New("no socket in /proc/net/tcp matches the peer")

// peerOwnsClaim refuses a hook request whose body names a "user" the calling
// account does not own. A peer that cannot be identified is refused too: the
// alternative is trusting the body again, which is the thing this closes.
func peerOwnsClaim(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, hookBodyLimit))
		if err != nil {
			http.Error(w, "cannot read body", http.StatusBadRequest)
			return
		}
		var claim struct {
			User string `json:"user"`
		}
		if json.Unmarshal(body, &claim) != nil || claim.User == "" {
			http.Error(w, "bad body (need user, session_id, tmux_session)", http.StatusBadRequest)
			return
		}
		who, err := peerUser(r)
		if err != nil {
			log.Printf("hook from %s claiming %q: cannot identify the caller: %v", r.RemoteAddr, claim.User, err)
			http.Error(w, "cannot identify the calling account", http.StatusForbidden)
			return
		}
		if who != claim.User {
			log.Printf("hook from %s (%s) claimed user %q", r.RemoteAddr, who, claim.User)
			http.Error(w, "user does not match the calling account", http.StatusForbidden)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next(w, r)
	}
}

// peerUser names the OS account that opened the connection r arrived on.
func peerUser(r *http.Request) (string, error) {
	peerIP, peerPort, ok := splitHostPortIP(r.RemoteAddr)
	if !ok {
		return "", errNoPeerSocket
	}
	// Our own end, when net/http put it on the context (it does for a served
	// request; httptest does not). It disambiguates a client port that another
	// of the peer's sockets happens to share.
	var localIP net.IP
	localPort := -1
	if la, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		if ip, port, ok := splitHostPortIP(la.String()); ok {
			localIP, localPort = ip, port
		}
	}

	uid, err := peerUID(peerIP, peerPort, localIP, localPort)
	if err != nil {
		return "", err
	}
	u, err := user.LookupId(strconv.Itoa(uid))
	if err != nil {
		return "", err
	}
	return u.Username, nil
}

// peerUID finds the socket the peer opened and answers with the uid that owns
// it. An ambiguous match (two sockets share the peer's endpoint and we do not
// know our own) is an error rather than a guess.
func peerUID(peerIP net.IP, peerPort int, localIP net.IP, localPort int) (int, error) {
	found := -1
	for _, path := range procNetTCP {
		f, err := os.Open(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return 0, err
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			fields := strings.Fields(sc.Text())
			if len(fields) < 8 {
				continue
			}
			ip, port, ok := parseProcAddr(fields[1])
			if !ok || port != peerPort || !ip.Equal(peerIP) {
				continue
			}
			if localIP != nil {
				rip, rport, ok := parseProcAddr(fields[2])
				if !ok || rport != localPort || !rip.Equal(localIP) {
					continue
				}
			}
			uid, err := strconv.Atoi(fields[7])
			if err != nil {
				continue
			}
			if found >= 0 && found != uid {
				f.Close()
				return 0, errors.New("two sockets match the peer")
			}
			found = uid
		}
		f.Close()
	}
	if found < 0 {
		return 0, errNoPeerSocket
	}
	return found, nil
}

// parseProcAddr decodes one "HEXADDR:HEXPORT" column. The address is the raw
// bytes in host order, so each 4-byte word comes back reversed on a
// little-endian machine, which is every machine this runs on.
func parseProcAddr(s string) (net.IP, int, bool) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return nil, 0, false
	}
	raw, err := hex.DecodeString(s[:i])
	if err != nil || (len(raw) != net.IPv4len && len(raw) != net.IPv6len) {
		return nil, 0, false
	}
	port, err := strconv.ParseUint(s[i+1:], 16, 16)
	if err != nil {
		return nil, 0, false
	}
	for j := 0; j+4 <= len(raw); j += 4 {
		raw[j], raw[j+1], raw[j+2], raw[j+3] = raw[j+3], raw[j+2], raw[j+1], raw[j]
	}
	return net.IP(raw), int(port), true
}

func splitHostPortIP(addr string) (net.IP, int, bool) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, 0, false
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	port, err := strconv.Atoi(portStr)
	if ip == nil || err != nil {
		return nil, 0, false
	}
	return ip, port, true
}
