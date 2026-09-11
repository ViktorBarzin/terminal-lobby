package main

import "testing"

// Since ADR-0019 a session name is a 12-character id, so a snapshot row on its
// own is unreadable: tmux-persist stores names, cwds and claude uuids, and a
// title is none of those. The titles file is the one place a title outlives its
// session, which is exactly the case the restore picker is for.

func TestAnnotateRowTitlesReadsTheRememberedTitle(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	store := swapTitleStore(t)
	mustSet(t, store, osSelf, "6j0wjvxxf7e5", "Restore feature session naming")
	mustSet(t, store, osSelf, "0qwwchjmxv9c", "Mobile keyboard simplification")

	rows := annotateRowTitles(osSelf, []SnapshotRow{
		{Name: "6j0wjvxxf7e5"},
		{Name: "0qwwchjmxv9c"},
		{Name: "4txnmy85ftja"}, // never titled
	})

	want := []string{"Restore feature session naming", "Mobile keyboard simplification", ""}
	for i, w := range want {
		if rows[i].Title != w {
			t.Errorf("row %d (%s) title = %q, want %q", i, rows[i].Name, rows[i].Title, w)
		}
	}
}

// The id-migration stamped some sessions with a title equal to their own name.
// Carrying that through would print the id twice in one row rather than once.
func TestAnnotateRowTitlesDropsATitleThatIsJustTheName(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	store := swapTitleStore(t)
	mustSet(t, store, osSelf, "74n0cmaawqcd", "74n0cmaawqcd")

	rows := annotateRowTitles(osSelf, []SnapshotRow{{Name: "74n0cmaawqcd"}})
	if rows[0].Title != "" {
		t.Errorf("title = %q, want it dropped as a duplicate of the name", rows[0].Title)
	}
}
