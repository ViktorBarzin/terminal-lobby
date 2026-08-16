package main

import (
	"reflect"
	"testing"
)

func TestCoownOpsForPatch(t *testing.T) {
	m := []string{"wizard", "bob"}
	cases := []struct {
		name   string
		was    bool
		oldDir string
		now    bool
		newDir string
		want   []coownOp
	}{
		{"enable with dir", false, "", true, "/home/wizard/code/p", []coownOp{{"grant", "/home/wizard/code/p", m}}},
		{"enable without dir", false, "", true, "", nil},
		{"disable", true, "/home/wizard/code/p", false, "/home/wizard/code/p", []coownOp{{"revoke", "/home/wizard/code/p", m}}},
		{"dir change while coowned", true, "/home/wizard/code/a", true, "/home/wizard/code/b",
			[]coownOp{{"revoke", "/home/wizard/code/a", m}, {"grant", "/home/wizard/code/b", m}}},
		{"same dir coowned no-op", true, "/home/wizard/code/p", true, "/home/wizard/code/p", nil},
		{"stays off", false, "", false, "/home/wizard/code/p", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := coownOpsForPatch(tc.was, tc.oldDir, tc.now, tc.newDir, m)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}
