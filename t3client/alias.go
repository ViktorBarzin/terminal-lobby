package t3client

import (
	"crypto/sha256"
	"encoding/base32"
	"regexp"
	"strings"
)

// AliasPrefix starts every lobby name for a T3 thread.
const AliasPrefix = "t3_"

var aliasRe = regexp.MustCompile(`^t3_[a-z2-7]{12}$`)

var lowerBase32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// Alias is the lobby session name for a T3 thread: "t3_" and the first 12
// characters of the lowercase, unpadded base32 of sha256(threadID). T3 ids
// such as "mcp:<uuid>" or "mcp:launch:<64 hex>" do not fit the lobby's name
// rule (^[a-zA-Z0-9_-]{1,32}$), and the alias does. 60 bits keep collisions
// out of reach for one user's thread list.
func Alias(threadID string) string {
	sum := sha256.Sum256([]byte(threadID))
	return AliasPrefix + lowerBase32.EncodeToString(sum[:])[:12]
}

// IsAlias reports whether name has the shape Alias produces.
func IsAlias(name string) bool {
	return strings.HasPrefix(name, AliasPrefix) && aliasRe.MatchString(name)
}
