package sessionio

import (
	"context"
	"reflect"
	"strconv"
	"time"
)

// Declining the tool permission prompt (permdialog.go) with words, through
// POST /answer: the card's "Type your own answer".
//
// The rules are answerdrive.go's: a reading before any key, a refusal that
// types nothing and carries that reading, every acting key held until a
// reading proves it will land where it is meant to, and a reply that is a
// reading taken afterwards. What is the prompt's own was measured on CLI
// 2.1.283 on 2026-09-27 (captures under testdata/permission-amend-*.txt):
//
//   - A DIGIT PICKS ITS ROW AT ONCE, the No row's included, so the No row's
//     digit declines with no words. The cursor gets there with ↓ instead,
//     one press at a time, each read back.
//   - TAB ON THE NO ROW OPENS ITS FIELD. The row reads "No, and tell Claude
//     what to do differently" and the footer drops "Tab to amend". Typing
//     and a paste go into the field and the row reads "No, <words>"; long
//     words wrap under the row at the words' column.
//   - THE FIELD'S TEXT CURSOR IS NOT WHERE IT LOOKS. ↑ off the field keeps the
//     words, and ↓ back onto it put a typed X in front of them ("No, Xprint
//     the date instead"), as the plan's feedback row does. C-e and Backspaces
//     cleared it and left the placeholder, with the cursor still on the row.
//   - ENTER ON THE FIELD DECLINES WITH THE WORDS. The transcript's tool result
//     reads "The user doesn't want to proceed with this tool use. … To tell
//     you how to proceed, the user said: <words>", and Claude carries on in
//     the same turn: asked to write "hi", told "write bye instead of hi", it
//     drew a new prompt for printf 'bye\n' a few seconds later.
//
// Enter goes in only on a reading whose No row holds exactly the words asked
// for, so it is never Enter on an empty field, whose outcome is not measured.
// The answer has landed when the prompt has gone (awaitGone): when no prompt
// is drawn, or when the one drawn no longer holds the words on its No row.
// Two tool calls Claude sent together ask one after the other, and the second
// prompt is up the moment the first is answered (an Edit declined with words
// and a Bash prompt under it, seen live 2026-09-27), so "still a permission
// prompt" is not "still the prompt that was answered".

// answerPermission applies one permission request against the reading taken
// before it.
func (in *Injector) answerPermission(ctx context.Context, osUser, session string, before answerReading, req AnswerRequest) (AnswerResponse, error) {
	// A request that answers a question as well says two things at once, as
	// does a row picked with words.
	if req.Answers != nil || req.Chat != nil {
		return before.reply(AnswerUnknownOption), nil
	}
	if req.Permission.Option != 0 {
		if req.Permission.Decline != "" {
			return before.reply(AnswerUnknownOption), nil
		}
		return in.permPick(ctx, osUser, session, before, req.Permission.Option, req.Permission.Label)
	}
	text := req.Permission.Decline
	// Checked before any key, as AnswerText would check it after the walk.
	if err := checkAnswerText(text); err != nil {
		return before.reply(AnswerRefused), nil
	}
	if before.perm.no == 0 {
		return before.reply(AnswerUnknownOption), nil
	}
	cur, reason, err := in.permFocusNo(ctx, osUser, session, before)
	if err == nil && reason == "" && !cur.perm.amended {
		cur, reason, err = in.permOpenField(ctx, osUser, session, cur)
	}
	if err == nil && reason == "" && !isPermPlaceholder(cur.perm.dialog.Options[cur.perm.no-1].Label) {
		cur, reason, err = in.permClearField(ctx, osUser, session, cur)
	}
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		return cur.reply(reason), nil
	}
	no := cur.perm.no
	typed, reason, err := in.typeAnswer(ctx, osUser, session, text, func(_, r answerReading) bool {
		return onPerm(r) && r.perm.cursor == no && r.perm.amended && typedMatches(r.perm.typed, text)
	})
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		// The words are not on the row, so Enter does not go in: on the row
		// as it stands it could decline with no words, or with others.
		return typed.reply(reason), nil
	}
	if err := in.Keys(osUser, session, []string{"Enter"}); err != nil {
		return typed.reply(AnswerRefused), nil
	}
	return in.awaitGone(ctx, osUser, session, typed, func(r answerReading) bool {
		return onPerm(r) && r.perm.cursor == no && r.perm.amended && typedMatches(r.perm.typed, text)
	})
}

// permPick picks the row numbered `n`, which must still be labelled `label`,
// with its digit. With the cursor in the No row's open field the digit would be
// typed into it, so the cursor walks off the field first (permOffField). The
// answer has landed when the prompt it was pressed on has gone.
func (in *Injector) permPick(ctx context.Context, osUser, session string, before answerReading, n int, label string) (AnswerResponse, error) {
	if _, ok := planOptionNamed(before.perm.dialog, n, label); !ok {
		return before.reply(AnswerUnknownOption), nil
	}
	cur, reason, err := in.permOffField(ctx, osUser, session, before)
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		return cur.reply(reason), nil
	}
	if err := in.Keys(osUser, session, []string{strconv.Itoa(n)}); err != nil {
		return cur.reply(AnswerRefused), nil
	}
	pressed := cur.dialog
	return in.awaitGone(ctx, osUser, session, cur, func(r answerReading) bool {
		return onPerm(r) && reflect.DeepEqual(r.dialog, pressed)
	})
}

// permOffField moves the cursor off the No row while its field is open under
// it, with one ↑, read back: off the field a digit picks its row again. An
// empty field closes as the cursor leaves it; words stay (measured on CLI
// 2.1.283, 2026-09-28). A reading with the cursor anywhere else needs nothing.
func (in *Injector) permOffField(ctx context.Context, osUser, session string, cur answerReading) (answerReading, string, error) {
	no := cur.perm.no
	if no == 0 || cur.perm.cursor != no || !cur.perm.amended {
		return cur, "", nil
	}
	if no == 1 {
		// No row over it to walk onto, and ↑ from the top row is not measured.
		return cur, AnswerUnverified, nil
	}
	if err := in.Keys(osUser, session, []string{"Up"}); err != nil {
		return in.refusal(osUser, session)
	}
	return in.permAwait(ctx, osUser, session, func(s *permScreen) bool {
		return s.cursor != 0 && s.cursor != no
	})
}

// permFocusNo walks the cursor onto the No row, one arrow per press, each read
// back before the next, and never further than the number of rows. Not with
// the row's digit, which declines at once.
func (in *Injector) permFocusNo(ctx context.Context, osUser, session string, before answerReading) (answerReading, string, error) {
	cur := before
	rows := len(before.perm.dialog.Options)
	for presses := 0; presses <= rows; presses++ {
		from, no := cur.perm.cursor, cur.perm.no
		switch {
		case from == no:
			return cur, "", nil
		case from == 0 || no == 0:
			return cur, AnswerUnverified, nil
		}
		key := "Down"
		if from > no {
			key = "Up"
		}
		if err := in.Keys(osUser, session, []string{key}); err != nil {
			return in.refusal(osUser, session)
		}
		next, reason, err := in.permAwait(ctx, osUser, session, func(s *permScreen) bool {
			return s.cursor != from && s.cursor != 0
		})
		if err != nil || reason != "" {
			return next, reason, err
		}
		// A press that moved the cursor away from the row, a wrap included,
		// is a walk that is not going where it should.
		if (key == "Down" && next.perm.cursor < from) || (key == "Up" && next.perm.cursor > from) {
			return next, AnswerUnverified, nil
		}
		cur = next
	}
	return cur, AnswerUnverified, nil
}

// permOpenField presses Tab with the cursor on the No row, and waits for the
// row to read as an open field.
func (in *Injector) permOpenField(ctx context.Context, osUser, session string, cur answerReading) (answerReading, string, error) {
	no := cur.perm.no
	if err := in.Keys(osUser, session, []string{"Tab"}); err != nil {
		return in.refusal(osUser, session)
	}
	return in.permAwait(ctx, osUser, session, func(s *permScreen) bool {
		return s.cursor == no && s.amended
	})
}

// permClearField empties the No row's field while the cursor is on it: C-e,
// then a Backspace for every character shown and clearMargin more
// (clearFieldKeys), in one run through rawKeys, since neither key is in the
// public allowlist. A run that leaves words behind ends the request.
func (in *Injector) permClearField(ctx context.Context, osUser, session string, cur answerReading) (answerReading, string, error) {
	no := cur.perm.no
	if err := in.rawKeys(osUser, session, clearFieldKeys(cur.perm.typed)...); err != nil {
		return in.refusal(osUser, session)
	}
	return in.permAwait(ctx, osUser, session, func(s *permScreen) bool {
		return s.cursor == no && s.amended && isPermPlaceholder(s.dialog.Options[no-1].Label)
	})
}

// permAwait reads the pane until the permission prompt is still up and `ok`
// holds for it, or the verify window runs out. A reading without the prompt
// ends the wait at once: something else answered it.
func (in *Injector) permAwait(ctx context.Context, osUser, session string, ok func(*permScreen) bool) (answerReading, string, error) {
	deadline := time.Now().Add(answerVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, "", err
		}
		cur, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, "", err
		}
		if !onPerm(cur) {
			return cur, AnswerUnverified, nil
		}
		if ok(cur.perm) {
			return cur, "", nil
		}
		if !time.Now().Before(deadline) {
			return cur, AnswerUnverified, nil
		}
	}
}

// onPerm reports whether a reading is of the tool permission prompt.
func onPerm(r answerReading) bool {
	return r.perm != nil && r.dialog != nil && r.dialog.Kind == DialogKindPermission
}
