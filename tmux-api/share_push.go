package main

import (
	"encoding/json"
	"log"
)

// Two pushes shared driving adds (ADR-0043): the guest hears they were invited,
// and the owner hears when a guest killed their session. Neither counts toward
// the app badge, which is about sessions waiting for you, so both leave it
// alone (pushPayload.Badge nil). Turn-done and question pushes stay with the
// owner; a guest gets nothing else.

// shareNavigateURL opens the lobby on a session someone else owns: the hash
// form the page reads for a foreign session (#name@owner), with tmux's session
// id after a `!` so the page still finds it once its first prompt has renamed
// it (frontend-v2 lib/foreign-hash.ts).
func shareNavigateURL(origin, owner, session, id string) string {
	u := origin + "/#" + session + "@" + owner
	if id != "" {
		u += "!" + id
	}
	return u
}

// buildSharedWithYouPayload is the guest's invite. from is the account that
// shared it, which is the owner.
func buildSharedWithYouPayload(from, owner, session, id, title, origin string) []byte {
	label := pushLabel(session, title)
	p := pushPayload{
		Title:   from + " shared " + label + " with you",
		Body:    "Open it from Shared with me in the lobby.",
		Tag:     "tl-share-" + owner + "-" + session,
		Session: session,
	}
	if origin != "" {
		p.WebPush = declarativeWebPushVersion
		p.Notification = &declarativeNotification{
			Title:    p.Title,
			Body:     p.Body,
			Navigate: shareNavigateURL(origin, owner, session, id),
			Tag:      p.Tag,
		}
	}
	b, _ := json.Marshal(p)
	return b
}

// buildGuestKilledPayload tells the owner a guest killed their session. The
// session is gone, so a tap opens the lobby rather than the session.
func buildGuestKilledPayload(guest, session, title, origin string) []byte {
	label := pushLabel(session, title)
	p := pushPayload{
		Title:   guest + " killed " + label,
		Body:    "A guest you shared it with ended the session. Restore in the lobby brings it back.",
		Tag:     "tl-" + session,
		Session: session,
	}
	if origin != "" {
		p.WebPush = declarativeWebPushVersion
		p.Notification = &declarativeNotification{
			Title: p.Title, Body: p.Body, Navigate: navigateURL(origin, ""), Tag: p.Tag,
		}
	}
	b, _ := json.Marshal(p)
	return b
}

// kindShare is the push kind for both, in the sender's one log line per push.
const kindShare = "share"

// pushSharedWithYou sends the invite to every device the guest has. A box with
// push switched off has no sender, and the invite is then only the sidebar.
func pushSharedWithYou(owner, guest, session, id, title string) {
	p := pushSenderInstance
	if p == nil {
		return
	}
	go func() {
		sent, _ := p.send(guest, session, func(origin string) []byte {
			return buildSharedWithYouPayload(owner, owner, session, id, title, origin)
		}, kindShare)
		log.Printf("share push: %s → %s for %s/%s, %d device(s)", owner, guest, owner, session, sent)
	}()
}

// pushGuestKilled tells the owner which guest killed which session.
func pushGuestKilled(owner, guest, session, title string) {
	p := pushSenderInstance
	if p == nil {
		return
	}
	go p.send(owner, session, func(origin string) []byte {
		return buildGuestKilledPayload(guest, session, title, origin)
	}, kindShare)
}
